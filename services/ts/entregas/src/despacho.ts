import { Envelope, Logger, Pool, PoolClient, criarEnvelope, publicarNaOutbox, transacao } from './comuns';
import { distanciaM } from './geo';
import { Hub } from './hub';

export interface Ultima {
  lat: number;
  lon: number;
  ts: number;
}

export interface Deps {
  pool: Pool;
  hub: Hub;
  ultimaPosicao: (entregadorId: number) => Promise<Ultima | null>;
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

// pedido.confirmado: cria a entrega (só pedidos com destino) e já tenta despachar.
// Pedidos do QR não têm destino: terminam em CONFIRMADO e não viram entrega.
export function aoConfirmarPedido(deps: Deps) {
  return async (c: PoolClient, e: Envelope, log: Logger, aposCommit: AposCommit) => {
    const p = e.payload;
    const { destino, entregadorPreferidoId } = lerEntrega(e);
    if (!destino) {
      log.info('pedido sem destino (QR): não há entrega');
      return;
    }
    const r = await c.query(
      `INSERT INTO entregas (pedido_id, entregador_preferido_id, origem_lat, origem_lon, destino_lat, destino_lon, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pedido_id) DO NOTHING`,
      [p.pedidoId, entregadorPreferidoId, p.origem.lat, p.origem.lon, destino.lat, destino.lon, e.correlationId],
    );
    if (r.rowCount) await tentarDespachar(c, Number(p.pedidoId), deps, aposCommit);
  };
}

// Escolhe o entregador: o preferido (só ele, se ocupado ou offline a entrega espera), ou o disponível
// mais próximo da loja. A atribuição é um UPDATE condicional (WHERE status = 'DISPONIVEL').
// Sem entregador livre a entrega fica PENDENTE e o laço de despacho tenta de novo.
export async function tentarDespachar(c: PoolClient, pedidoId: number, deps: Deps, aposCommit: AposCommit): Promise<boolean> {
  const e = await c.query("SELECT * FROM entregas WHERE pedido_id = $1 AND status = 'PENDENTE' FOR UPDATE", [pedidoId]);
  if (!e.rowCount) return false;
  const entrega = e.rows[0];

  let candidatos: number[];
  if (entrega.entregador_preferido_id) {
    candidatos = [Number(entrega.entregador_preferido_id)];
  } else {
    const livres = await c.query("SELECT id FROM entregadores WHERE status = 'DISPONIVEL'");
    const comDistancia = await Promise.all(
      livres.rows.map(async (l) => {
        const u = await deps.ultimaPosicao(Number(l.id));
        // sem posição conhecida fica por último, mas continua elegível
        return { id: Number(l.id), d: u ? distanciaM(entrega.origem_lat, entrega.origem_lon, u.lat, u.lon) : Infinity };
      }),
    );
    candidatos = comDistancia.sort((a, b) => a.d - b.d || a.id - b.id).map((x) => x.id);
  }

  for (const id of candidatos) {
    const claim = await c.query(
      "UPDATE entregadores SET status = 'OCUPADO' WHERE id = $1 AND status = 'DISPONIVEL' RETURNING id, nome",
      [id],
    );
    if (!claim.rowCount) continue;
    const { nome } = claim.rows[0];
    await c.query("UPDATE entregas SET status = 'ATRIBUIDA', entregador_id = $1 WHERE pedido_id = $2", [id, pedidoId]);
    await publicarNaOutbox(c, criarEnvelope('entrega.atribuida', entrega.correlation_id, { pedidoId, entregadorId: id, entregadorNome: nome }));
    deps.log.info({ pedidoId, entregadorId: id }, 'entrega atribuída');
    aposCommit(() => deps.hub.transmitir({ type: 'entrega', evento: 'atribuida', pedidoId, entregadorId: id }));
    return true;
  }
  return false;
}

// Laço: entregas PENDENTES tentam de novo a cada intervalo (entregador que ficou livre, que voltou, etc.)
export async function despacharPendentes(deps: Deps): Promise<number> {
  const pendentes = await deps.pool.query("SELECT pedido_id FROM entregas WHERE status = 'PENDENTE' ORDER BY criada_em");
  let feitas = 0;
  for (const p of pendentes.rows) {
    const depois: (() => void)[] = [];
    const ok = await transacao(deps.pool, (c) => tentarDespachar(c, Number(p.pedido_id), deps, (a) => depois.push(a)));
    if (ok) {
      feitas++;
      depois.forEach((a) => a());
    }
  }
  return feitas;
}
