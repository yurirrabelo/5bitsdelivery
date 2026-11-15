import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { ChannelWrapper } from 'amqp-connection-manager';
import { Pool, PoolClient } from 'pg';
import { Broker } from './broker';
import { dormir } from './config';
import { MensagemInvalida, ValidadorContratos } from './contratos';
import { erroDeInfra, transacao } from './db';
import { Envelope } from './envelope';
import { registrarNaInbox } from './inbox';
import { Logger } from './logger';
import { mensagens } from './metricas';

// O manipulador roda na mesma transação da inbox: se lançar erro, nada é gravado.
// aposCommit registra uma ação (ex.: avisar o WebSocket) que só roda depois que a transação confirmou.
export type Manipulador = (
  c: PoolClient,
  envelope: Envelope,
  log: Logger,
  aposCommit: (acao: () => void) => void,
) => Promise<void>;

// Compartilhado com o /health: true enquanto o consumidor segura uma mensagem por falha de infraestrutura
export class EstadoSaude {
  segurando = false;
}

export interface OpcoesConsumidor {
  broker: Broker;
  pool: Pool;
  fila: string;
  manipuladores: Record<string, Manipulador>;
  validador: ValidadorContratos;
  log: Logger;
  estado: EstadoSaude;
  backoffInicialMs?: number;
  backoffMaxMs?: number;
}

// Consumo com ack manual e prefetch 1.
//  - Erro da mensagem (JSON/contrato inválido, erro do manipulador): reject com requeue. A fila quorum conta as
//    entregas e, ao passar de x-delivery-limit, manda para a DLQ. As outras mensagens seguem.
//    Atenção: no RabbitMQ 4 o nack com requeue NÃO incrementa a contagem (a mensagem nunca iria para a DLQ);
//    o reject com requeue incrementa. Por isso usamos reject.
//  - Erro de infraestrutura (banco fora): segura a mensagem sem ack e tenta de novo com backoff.
//    Assim uma queda de banco não manda mensagem boa para a DLQ.
export function iniciarConsumidor(o: OpcoesConsumidor): ChannelWrapper {
  const canal = o.broker.conexao.createChannel({
    name: `consumidor-${o.fila}`,
    setup: async (ch: ConfirmChannel) => {
      await ch.prefetch(1);
      await ch.consume(
        o.fila,
        (msg) => {
          if (msg) void tratar(o, ch, msg);
        },
        { noAck: false },
      );
    },
  });
  canal.on('error', (e: unknown) =>
    o.log.warn({ err: (e as Error).message, fila: o.fila }, 'canal do consumidor com erro; recriando'),
  );
  return canal;
}

async function tratar(o: OpcoesConsumidor, ch: ConfirmChannel, msg: ConsumeMessage): Promise<void> {
  const tipo = msg.fields.routingKey;
  let espera = o.backoffInicialMs ?? 500;
  for (;;) {
    try {
      const resultado = await processar(o, msg);
      o.estado.segurando = false;
      mensagens.add(1, { type: tipo, resultado });
      return responder(o, () => ch.ack(msg));
    } catch (e) {
      if (erroDeInfra(e)) {
        o.estado.segurando = true;
        o.log.warn({ type: tipo, err: (e as Error).message, espera }, 'infraestrutura indisponível; segurando a mensagem');
        await dormir(espera);
        espera = Math.min(espera * 2, o.backoffMaxMs ?? 10000);
        continue;
      }
      o.estado.segurando = false;
      mensagens.add(1, { type: tipo, resultado: 'erro' });
      const tentativa = Number(msg.properties.headers?.['x-delivery-count'] ?? 0) + 1;
      o.log.error({ type: tipo, err: (e as Error).message, tentativa }, 'erro na mensagem; devolvendo para a fila');
      return responder(o, () => ch.reject(msg, true));
    }
  }
}

async function processar(o: OpcoesConsumidor, msg: ConsumeMessage): Promise<'processada' | 'duplicada'> {
  let envelope: Envelope;
  try {
    envelope = o.validador.validar(JSON.parse(msg.content.toString('utf8')));
  } catch (e) {
    throw e instanceof MensagemInvalida ? e : new MensagemInvalida(`JSON inválido: ${(e as Error).message}`);
  }
  const manipulador = o.manipuladores[envelope.type];
  if (!manipulador) throw new MensagemInvalida(`sem manipulador para ${envelope.type}`);

  const log = o.log.child({
    correlationId: envelope.correlationId,
    messageId: envelope.messageId,
    type: envelope.type,
    pedidoId: envelope.payload?.pedidoId,
  });
  const aposCommit: (() => void)[] = [];
  const resultado = await transacao(o.pool, async (c) => {
    if (!(await registrarNaInbox(c, envelope))) {
      log.info('mensagem duplicada descartada');
      return 'duplicada' as const;
    }
    await manipulador(c, envelope, log, (acao) => aposCommit.push(acao));
    return 'processada' as const;
  });
  for (const acao of aposCommit) {
    try {
      acao();
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'ação pós-commit falhou');
    }
  }
  return resultado;
}

// ack/nack falham se o canal caiu no meio; o broker devolve a mensagem e a inbox descarta a repetição
function responder(o: OpcoesConsumidor, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    o.log.warn({ err: (e as Error).message }, 'não consegui confirmar a mensagem (canal caiu); ela volta para a fila');
  }
}
