import { Envelope, Logger, Manipulador, criarEnvelope, publicarNaOutbox } from '@delivery/commons';
import { PoolClient } from 'pg';
import { Gateway } from './gateway';
import { duracaoGateway, pagamentos } from './metricas';

export interface Dependencias {
  gateway: Gateway;
  agora?: () => Date; // para os testes
}

// Cobra o pedido no gateway (com a chave de idempotência do pedido) e responde aprovado ou recusado.
// Roda na transação da inbox: se a réplica morrer no meio, nada é gravado e outra réplica refaz a chamada
// com a mesma chave, e a cobrança acontece uma vez só.
export function cobrar(dep: Dependencias): Manipulador {
  return async (c: PoolClient, e: Envelope, log: Logger) => {
    const pedidoId = Number(e.payload.pedidoId);
    const agora = dep.agora ?? (() => new Date());

    // comando repetido com outro messageId: não cobra de novo, só repete a resposta
    const existente = await c.query('SELECT status, referencia, motivo FROM pagamentos WHERE pedido_id = $1', [pedidoId]);
    if (existente.rowCount) {
      const p = existente.rows[0];
      log.info({ status: p.status }, 'pagamento já existe; repetindo a resposta');
      if (p.status === 'APROVADO' || p.status === 'ESTORNADO') {
        await responder(c, e, 'pagamento.aprovado', { pedidoId, referencia: p.referencia });
      } else {
        await responder(c, e, 'pagamento.recusado', { pedidoId, motivo: p.motivo });
      }
      return;
    }

    // não começa uma cobrança já vencida: evita cobrar e estornar à toa
    if (new Date(e.payload.expiraEm).getTime() <= agora().getTime()) {
      await gravarRecusa(c, e, pedidoId, 'PRAZO_EXPIRADO');
      log.warn('cobrança vencida, recusada sem chamar o gateway');
      return;
    }

    log.info('chamando o gateway');
    const inicio = Date.now();
    const r = await dep.gateway.cobrar(pedidoId);
    duracaoGateway.record(Date.now() - inicio);

    if (r.status === 'APROVADO') {
      await c.query("INSERT INTO pagamentos (pedido_id, status, referencia) VALUES ($1, 'APROVADO', $2)", [pedidoId, r.referencia]);
      await responder(c, e, 'pagamento.aprovado', { pedidoId, referencia: r.referencia });
      pagamentos.add(1, { resultado: 'aprovado' });
      log.info({ referencia: r.referencia }, 'pagamento aprovado');
    } else {
      await gravarRecusa(c, e, pedidoId, 'GATEWAY_FALHOU');
      log.warn({ erro: r.erro }, 'gateway falhou; pagamento recusado');
    }
  };
}

// Estorna uma cobrança aprovada (aprovação que chegou depois do cancelamento do pedido).
export function estornar(dep: Dependencias): Manipulador {
  return async (c: PoolClient, e: Envelope, log: Logger) => {
    const pedidoId = Number(e.payload.pedidoId);
    const r = await c.query(
      "UPDATE pagamentos SET status = 'ESTORNADO', atualizado_em = now() WHERE pedido_id = $1 AND status = 'APROVADO'",
      [pedidoId],
    );
    if (r.rowCount) {
      // se o gateway estiver fora lança ErroInfraestrutura: o UPDATE sofre rollback e a mensagem fica retida
      await dep.gateway.estornar(pedidoId);
      await responder(c, e, 'pagamento.estornado', { pedidoId });
      pagamentos.add(1, { resultado: 'estornado' });
      log.info('pagamento estornado');
      return;
    }
    // estorno repetido: já estornado, só repete a resposta. Sem cobrança aprovada não há o que estornar.
    const atual = await c.query('SELECT status FROM pagamentos WHERE pedido_id = $1', [pedidoId]);
    if (atual.rows[0]?.status === 'ESTORNADO') await responder(c, e, 'pagamento.estornado', { pedidoId });
    else log.warn({ status: atual.rows[0]?.status ?? 'inexistente' }, 'nada a estornar');
  };
}

async function gravarRecusa(c: PoolClient, e: Envelope, pedidoId: number, motivo: 'GATEWAY_FALHOU' | 'PRAZO_EXPIRADO') {
  await c.query("INSERT INTO pagamentos (pedido_id, status, motivo) VALUES ($1, 'RECUSADO', $2)", [pedidoId, motivo]);
  await responder(c, e, 'pagamento.recusado', { pedidoId, motivo });
  pagamentos.add(1, { resultado: 'recusado' });
}

// a resposta herda o correlationId do comando recebido
async function responder(c: PoolClient, comando: Envelope, tipo: string, payload: object) {
  await publicarNaOutbox(c, criarEnvelope(tipo, comando.correlationId, payload));
}
