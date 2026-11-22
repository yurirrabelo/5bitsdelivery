import { PoolClient, criarEnvelope, publicarNaOutbox } from './comuns';
import { Deps } from './ofertas';

type AposCommit = (acao: () => void) => void;

// Conclui a entrega (geofence ou botão). UPDATE condicional: só conclui uma vez, só se estiver ATRIBUIDA.
// O entregador volta a ficar DISPONIVEL na mesma transação que grava o evento entrega.concluida.
export async function concluirEntrega(
  c: PoolClient,
  pedidoId: number,
  modo: 'geofence' | 'manual',
  deps: Deps,
  aposCommit: AposCommit,
): Promise<boolean> {
  const r = await c.query(
    "UPDATE entregas SET status = 'CONCLUIDA', concluida_em = now() WHERE pedido_id = $1 AND status = 'ATRIBUIDA' RETURNING entregador_id, correlation_id",
    [pedidoId],
  );
  if (!r.rowCount) return false;
  const { entregador_id: entregadorId, correlation_id: correlationId } = r.rows[0];
  await c.query("UPDATE entregadores SET status = 'DISPONIVEL' WHERE id = $1 AND status = 'OCUPADO'", [entregadorId]);
  await publicarNaOutbox(c, criarEnvelope('entrega.concluida', correlationId, { pedidoId, entregadorId, modo }));
  deps.log.info({ pedidoId, entregadorId, modo }, 'entrega concluída');
  aposCommit(() => deps.hub.transmitir({ type: 'entrega', evento: 'concluida', pedidoId, entregadorId }));
  return true;
}
