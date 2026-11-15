import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Publicador, PropsMensagem } from '../src/broker';
import { transacao } from '../src/db';
import { criarEnvelope } from '../src/envelope';
import { PublicadorOutbox, publicarNaOutbox } from '../src/outbox';
import { loggerCapturado, novoPool, prepararBanco } from './ajuda';

class BrokerFalso implements Publicador {
  online = true;
  enviadas: { exchange: string; routingKey: string; corpo: string; props: PropsMensagem }[] = [];
  conectado() {
    return this.online;
  }
  async publicar(exchange: string, routingKey: string, corpo: string, props: PropsMensagem) {
    this.enviadas.push({ exchange, routingKey, corpo, props });
  }
}

let pool: Pool;
let broker: BrokerFalso;
let publicador: PublicadorOutbox;
const novo = (tipo = 'estoque.reservar', pedidoId = 1) => criarEnvelope(tipo, randomUUID(), { pedidoId });

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider());
  pool = novoPool();
  await prepararBanco(pool);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query('TRUNCATE outbox');
  broker = new BrokerFalso();
  publicador = new PublicadorOutbox(pool, broker, loggerCapturado().log, { exchange: 'delivery.eventos' });
});

describe('outbox', () => {
  it('é atômica com o efeito: rollback não deixa mensagem', async () => {
    await expect(
      transacao(pool, async (c) => {
        await c.query('INSERT INTO efeitos (message_id) VALUES ($1)', [randomUUID()]);
        await publicarNaOutbox(c, novo());
        throw new Error('falha depois de gravar');
      }),
    ).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM efeitos')).rows[0].n).toBe(0);
  });

  it('publica as pendentes uma vez só e marca como publicadas', async () => {
    const e = novo();
    await transacao(pool, (c) => publicarNaOutbox(c, e));
    expect(await publicador.ciclo()).toBe(1);
    expect(broker.enviadas).toHaveLength(1);
    expect(broker.enviadas[0].routingKey).toBe('estoque.reservar');
    expect(broker.enviadas[0].props.messageId).toBe(e.messageId);
    expect(JSON.parse(broker.enviadas[0].corpo).payload).toEqual({ pedidoId: 1 });
    expect(await publicador.ciclo()).toBe(0);
    const r = await pool.query('SELECT publicada_em FROM outbox');
    expect(r.rows[0].publicada_em).not.toBeNull();
  });

  it('com o broker fora as mensagens esperam; ao voltar, saem em ordem', async () => {
    broker.online = false;
    for (const id of [1, 2, 3]) await transacao(pool, (c) => publicarNaOutbox(c, novo('estoque.reservar', id)));
    expect(await publicador.ciclo()).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE publicada_em IS NULL')).rows[0].n).toBe(3);

    broker.online = true;
    expect(await publicador.ciclo()).toBe(3);
    expect(broker.enviadas.map((m) => JSON.parse(m.corpo).payload.pedidoId)).toEqual([1, 2, 3]);
  });

  it('falha no meio do lote: marca só as que saíram e as outras tentam de novo', async () => {
    for (const id of [1, 2, 3]) await transacao(pool, (c) => publicarNaOutbox(c, novo('estoque.reservar', id)));
    const original = broker.publicar.bind(broker);
    let chamadas = 0;
    broker.publicar = async (...args) => {
      if (++chamadas === 2) throw new Error('confirm não veio');
      return original(...args);
    };
    expect(await publicador.ciclo()).toBe(1);
    broker.publicar = original;
    expect(await publicador.ciclo()).toBe(2);
    expect(broker.enviadas.map((m) => JSON.parse(m.corpo).payload.pedidoId)).toEqual([1, 2, 3]);
  });

  it('duas instâncias do publicador não publicam a mesma mensagem (SKIP LOCKED)', async () => {
    for (let id = 1; id <= 20; id++) await transacao(pool, (c) => publicarNaOutbox(c, novo('estoque.reservar', id)));
    const outroBroker = new BrokerFalso();
    const outro = new PublicadorOutbox(pool, outroBroker, loggerCapturado().log, { exchange: 'x', lote: 5 });
    const meu = new PublicadorOutbox(pool, broker, loggerCapturado().log, { exchange: 'x', lote: 5 });
    await Promise.all([meu.ciclo(), outro.ciclo(), meu.ciclo(), outro.ciclo(), meu.ciclo(), outro.ciclo()]);
    const ids = [...broker.enviadas, ...outroBroker.enviadas].map((m) => JSON.parse(m.corpo).payload.pedidoId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });
});

describe('traceparent na outbox', () => {
  it('guarda o traceparent do trace ativo e o restaura ao publicar', async () => {
    const span = trace.getTracer('teste').startSpan('pedido');
    const traceId = span.spanContext().traceId;
    await context.with(trace.setSpan(context.active(), span), () => transacao(pool, (c) => publicarNaOutbox(c, novo())));
    span.end();

    const guardado = (await pool.query('SELECT traceparent FROM outbox')).rows[0].traceparent as string;
    expect(guardado).toContain(traceId);

    await publicador.ciclo();
    // o publicador roda fora do trace original e mesmo assim mantém o mesmo trace
    expect(broker.enviadas[0].props.traceparent).toContain(traceId);
  });

  it('sem trace ativo usa o traceparent padrão (o guardado no pedido)', async () => {
    const padrao = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await transacao(pool, (c) => publicarNaOutbox(c, novo(), padrao));
    expect((await pool.query('SELECT traceparent FROM outbox')).rows[0].traceparent).toBe(padrao);
    await publicador.ciclo();
    expect(broker.enviadas[0].props.traceparent).toContain('0af7651916cd43dd8448eb211c80319c');
  });
});
