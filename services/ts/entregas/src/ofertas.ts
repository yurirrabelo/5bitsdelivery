import { Envelope, Logger, Pool, PoolClient, criarEnvelope, publicarNaOutbox } from './comuns';
import { Hub } from './hub';

export interface Deps {
  pool: Pool;
  hub: Hub;
  log: Logger;
}

type AposCommit = (acao: () => void) => void;

export interface DadosEntrega {
  destino: { lat: number; lon: number } | null;
  entregadorPreferidoId: number | null;
}

// Versionamento do pedido.confirmado: a v2 traz os dados de entrega dentro de "entrega". Quem lê entende as
// duas versões e converte a v1 para a v2 ao ler (as mensagens antigas na fila continuam funcionando).
export function lerEntrega(e: Envelope): DadosEntrega {
  const p = e.payload;
  const d = e.version >= 2 ? p.entrega : p; // v1: destino e entregadorPreferidoId ficam direto no payload
  return { destino: d?.destino ?? null, entregadorPreferidoId: d?.entregadorPreferidoId ?? null };
}

// pedido.confirmado: cria a entrega (só pedidos com endereço de entrega) e deixa ela ESPERANDO um entregador aceitar.
// Pedidos sem endereço (os do QR antigo, sem GPS) terminam em CONFIRMADO e não viram entrega.
export function aoConfirmarPedido(deps: Deps) {
  return async (c: PoolClient, e: Envelope, log: Logger, aposCommit: AposCommit) => {
    const p = e.payload;
    const { destino, entregadorPreferidoId } = lerEntrega(e);
    if (!destino) {
      log.info('pedido sem endereço de entrega: não há entrega');
      return;
    }
    const r = await c.query(
      `INSERT INTO entregas (pedido_id, entregador_preferido_id, origem_lat, origem_lon, destino_lat, destino_lon, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pedido_id) DO NOTHING`,
      [p.pedidoId, entregadorPreferidoId, p.origem.lat, p.origem.lon, destino.lat, destino.lon, e.correlationId],
    );
    if (r.rowCount) {
      log.info({ pedidoId: p.pedidoId }, 'entrega esperando um entregador aceitar');
      aposCommit(() => deps.hub.transmitir({ type: 'entrega', evento: 'pendente', pedidoId: Number(p.pedidoId) }));
    }
  };
}

export interface Oferta {
  pedidoId: number;
  destino: { lat: number; lon: number };
}

// Os pedidos esperando entregador que este entregador pode aceitar: os de qualquer um e os feitos para ele.
// Mais antigos primeiro.
export async function listarOfertas(pool: Pool, entregadorId: number): Promise<Oferta[]> {
  const r = await pool.query(
    `SELECT pedido_id, destino_lat, destino_lon FROM entregas
      WHERE status = 'PENDENTE' AND (entregador_preferido_id IS NULL OR entregador_preferido_id = $1)
      ORDER BY criada_em LIMIT 20`,
    [entregadorId],
  );
  return r.rows.map((o) => ({ pedidoId: Number(o.pedido_id), destino: { lat: o.destino_lat, lon: o.destino_lon } }));
}

export type Aceite = 'aceita' | 'entrega_indisponivel' | 'entregador_indisponivel';

// O entregador aceita um pedido. Só vale se a entrega ainda estiver esperando (e for de qualquer um ou dele) e se
// ele estiver Disponível. São UPDATEs condicionais na mesma transação: se dois entregadores aceitam ao mesmo tempo,
// o primeiro fica com o pedido e o outro recebe "indisponível". Quando recusa, nada foi alterado.
export async function aceitarEntrega(c: PoolClient, pedidoId: number, entregadorId: number, deps: Deps, aposCommit: AposCommit): Promise<Aceite> {
  const e = await c.query("SELECT correlation_id, entregador_preferido_id FROM entregas WHERE pedido_id = $1 AND status = 'PENDENTE' FOR UPDATE", [pedidoId]);
  if (!e.rowCount) return 'entrega_indisponivel'; // já aceita por outro entregador (ou não existe)
  const entrega = e.rows[0];
  if (entrega.entregador_preferido_id && Number(entrega.entregador_preferido_id) !== entregadorId) return 'entrega_indisponivel';

  const claim = await c.query("UPDATE entregadores SET status = 'OCUPADO' WHERE id = $1 AND status = 'DISPONIVEL' RETURNING nome", [entregadorId]);
  if (!claim.rowCount) return 'entregador_indisponivel';

  await c.query("UPDATE entregas SET status = 'ATRIBUIDA', entregador_id = $1 WHERE pedido_id = $2", [entregadorId, pedidoId]);
  await publicarNaOutbox(c, criarEnvelope('entrega.atribuida', entrega.correlation_id, { pedidoId, entregadorId, entregadorNome: claim.rows[0].nome }));
  deps.log.info({ pedidoId, entregadorId }, 'entrega aceita pelo entregador');
  aposCommit(() => deps.hub.transmitir({ type: 'entrega', evento: 'atribuida', pedidoId, entregadorId }));
  return 'aceita';
}
