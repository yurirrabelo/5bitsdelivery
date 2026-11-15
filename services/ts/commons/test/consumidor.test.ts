import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Broker } from '../src/broker';
import { EstadoSaude, iniciarConsumidor } from '../src/consumidor';
import { ValidadorContratos } from '../src/contratos';
import { transacao } from '../src/db';
import { criarEnvelope } from '../src/envelope';
import { PublicadorOutbox, publicarNaOutbox } from '../src/outbox';
import { AMQP_URL, criarTopologia, esperar, loggerCapturado, novoPool, prepararBanco } from './ajuda';

let pool: Pool;
let broker: Broker;
const validador = new ValidadorContratos();
const reservar = (pedidoId = 1) => criarEnvelope('estoque.reservar', randomUUID(), { pedidoId });
const contar = async (tabela: string) => (await pool.query(`SELECT count(*)::int n FROM ${tabela}`)).rows[0].n as number;

beforeAll(async () => {
  pool = novoPool();
  await prepararBanco(pool);
  broker = new Broker(AMQP_URL, loggerCapturado().log);
  await esperar(() => broker.conectado());
});
afterAll(async () => {
  await broker.fechar();
  await pool.end();
});
beforeEach(() => prepararBanco(pool));

// Sobe um consumidor com um manipulador de estoque.reservar que grava um "efeito" no banco
async function montar(manipulador?: (c: any, env: any) => Promise<void>, limite = 2) {
  const topo = await criarTopologia(['estoque.reservar'], limite);
  const capturado = loggerCapturado();
  const estado = new EstadoSaude();
  let chamadas = 0;
  iniciarConsumidor({
    broker,
    pool,
    fila: topo.fila,
    validador,
    log: capturado.log,
    estado,
    backoffInicialMs: 50,
    backoffMaxMs: 200,
    manipuladores: {
      'estoque.reservar': async (c, env, log) => {
        chamadas++;
        if (manipulador) return manipulador(c, env);
        await c.query('INSERT INTO efeitos (message_id) VALUES ($1)', [env.messageId]);
      },
    },
  });
  return { topo, capturado, estado, chamadas: () => chamadas };
}

describe('consumidor: inbox e idempotência', () => {
  it('mesma mensagem 5 vezes: um efeito, quatro descartadas', async () => {
    const { topo, capturado } = await montar();
    const e = reservar();
    for (let i = 0; i < 5; i++) topo.publicar('estoque.reservar', e);
    // sentinela: o consumidor é único e em ordem, então quando ela passar as repetições já foram tratadas
    topo.publicar('estoque.reservar', reservar(2));
    await esperar(async () => (await contar('mensagens_processadas')) === 2);

    expect(await contar('efeitos')).toBe(2); // a mensagem repetida + a sentinela
    expect((await pool.query('SELECT count(*)::int n FROM efeitos WHERE message_id = $1', [e.messageId])).rows[0].n).toBe(1);
    expect(capturado.conta('mensagem duplicada descartada')).toBe(4);
    await topo.fechar();
  });

  it('se o efeito falha, a inbox não guarda o messageId e a nova entrega funciona', async () => {
    let tentativas = 0;
    const { topo, chamadas } = await montar(async (c, env) => {
      await c.query('INSERT INTO efeitos (message_id) VALUES ($1)', [env.messageId]);
      if (++tentativas === 1) throw new Error('falha no efeito, depois do INSERT');
    });
    topo.publicar('estoque.reservar', reservar());
    await esperar(async () => (await contar('mensagens_processadas')) === 1);

    expect(chamadas()).toBe(2);
    expect(await contar('efeitos')).toBe(1); // o INSERT da primeira tentativa sofreu rollback
    await topo.fechar();
  });
});

describe('consumidor: erro de mensagem e DLQ', () => {
  it('mensagem venenosa: 3 tentativas e DLQ, sem travar as outras', async () => {
    const { topo, capturado, chamadas } = await montar(undefined, 2); // limite 2 = MAX_TENTATIVAS(3) - 1
    topo.publicar('estoque.reservar', 'isto não é JSON');
    topo.publicar('estoque.reservar', reservar(5));
    topo.publicar('estoque.reservar', reservar(6));

    await esperar(async () => (await topo.tamanho(topo.dlq)) === 1);
    await esperar(async () => (await contar('mensagens_processadas')) === 2);

    expect(capturado.conta('erro na mensagem')).toBe(3);
    expect(chamadas()).toBe(2); // o manipulador nunca viu a venenosa
    expect(await contar('efeitos')).toBe(2);
    await topo.fechar();
  });

  it('payload que viola o contrato também vai para a DLQ', async () => {
    const { topo } = await montar(undefined, 2);
    topo.publicar('estoque.reservar', { ...reservar(), payload: { pedidoId: 'abc' } });
    await esperar(async () => (await topo.tamanho(topo.dlq)) === 1);
    expect(await contar('efeitos')).toBe(0);
    await topo.fechar();
  });
});

describe('consumidor: erro de infraestrutura', () => {
  it('banco fora: segura a mensagem, não manda para a DLQ e processa quando volta', async () => {
    let falhas = 0;
    const { topo, capturado, estado } = await montar(async (c, env) => {
      if (falhas++ < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      await c.query('INSERT INTO efeitos (message_id) VALUES ($1)', [env.messageId]);
    });
    topo.publicar('estoque.reservar', reservar());

    await esperar(() => estado.segurando); // /health fica 503 enquanto segura
    await esperar(async () => (await contar('mensagens_processadas')) === 1);

    expect(estado.segurando).toBe(false);
    expect(capturado.conta('segurando a mensagem')).toBe(3);
    expect(capturado.conta('erro na mensagem')).toBe(0);
    expect(await topo.tamanho(topo.dlq)).toBe(0);
    expect(await contar('efeitos')).toBe(1);
    await topo.fechar();
  });
});

describe('ponta a ponta: outbox → RabbitMQ → inbox → efeito', () => {
  it('a mensagem gravada na outbox chega ao consumidor e produz um efeito só', async () => {
    const { topo } = await montar();
    const publicador = new PublicadorOutbox(pool, broker, loggerCapturado().log, { exchange: topo.exchange });
    const e = reservar(42);
    await transacao(pool, (c) => publicarNaOutbox(c, e));

    expect(await publicador.ciclo()).toBe(1);
    await esperar(async () => (await contar('efeitos')) === 1);
    expect((await pool.query('SELECT count(*)::int n FROM efeitos WHERE message_id = $1', [e.messageId])).rows[0].n).toBe(1);
    await topo.fechar();
  });
});
