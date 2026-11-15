import amqplib from 'amqplib';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { Pool } from 'pg';
import { criarPool, migrar } from '../src/db';

export const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://teste:teste@localhost:5672';
const PG_URL = new URL(process.env.TEST_PG_URL ?? 'postgres://teste:teste@localhost:5432/teste');

export function novoPool(): Pool {
  return criarPool({
    host: PG_URL.hostname,
    port: Number(PG_URL.port || 5432),
    dbname: PG_URL.pathname.slice(1),
    username: PG_URL.username,
    password: PG_URL.password,
  });
}

// Banco de teste: tabelas da commons, a tabela de efeitos e tudo limpo
export async function prepararBanco(pool: Pool): Promise<void> {
  await migrar(pool);
  await pool.query('CREATE TABLE IF NOT EXISTS efeitos (id SERIAL PRIMARY KEY, message_id UUID)');
  await pool.query('TRUNCATE outbox, mensagens_processadas, efeitos RESTART IDENTITY');
}

export async function esperar(condicao: () => Promise<boolean> | boolean, ms = 15000): Promise<void> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('tempo esgotado esperando a condição');
}

// Logger que guarda as linhas em memória, para os testes conferirem o que foi logado
export function loggerCapturado() {
  const linhas: string[] = [];
  const log = pino({ level: 'info' }, { write: (s: string) => void linhas.push(s) });
  return { log, linhas, conta: (trecho: string) => linhas.filter((l) => l.includes(trecho)).length };
}

// Exchange topic + fila quorum com DLX e limite de entregas, como o Terraform cria no sistema real
export async function criarTopologia(tipos: string[], limiteEntregas = 2) {
  const id = randomUUID().slice(0, 8);
  const nomes = { exchange: `ex.${id}`, dlx: `dlx.${id}`, fila: `q.${id}`, dlq: `q.${id}.dlq` };
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertExchange(nomes.exchange, 'topic', { durable: true });
  await ch.assertExchange(nomes.dlx, 'direct', { durable: true });
  await ch.assertQueue(nomes.dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(nomes.dlq, nomes.dlx, nomes.fila);
  await ch.assertQueue(nomes.fila, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': nomes.dlx,
      'x-dead-letter-routing-key': nomes.fila,
      'x-delivery-limit': limiteEntregas,
    },
  });
  for (const tipo of tipos) await ch.bindQueue(nomes.fila, nomes.exchange, tipo);
  return {
    ...nomes,
    publicar: (tipo: string, corpo: string | object) =>
      ch.publish(nomes.exchange, tipo, Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)), {
        persistent: true,
        contentType: 'application/json',
      }),
    tamanho: async (fila: string) => (await ch.checkQueue(fila)).messageCount,
    fechar: async () => {
      await ch.deleteQueue(nomes.fila).catch(() => undefined);
      await ch.deleteQueue(nomes.dlq).catch(() => undefined);
      await conn.close().catch(() => undefined);
    },
  };
}
