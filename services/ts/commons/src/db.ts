import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { dormir, env } from './config';
import { Logger } from './logger';
import { lerSegredo } from './segredos';

export type Queryable = Pick<PoolClient, 'query'>;

export interface ConfigBanco {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

export function criarPool(cfg: ConfigBanco, log?: Logger): Pool {
  const pool = new Pool({
    host: cfg.host,
    port: Number(cfg.port),
    database: cfg.dbname,
    user: cfg.username,
    password: cfg.password,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // sem este handler, uma conexão ociosa derrubada pelo banco matava o processo
  pool.on('error', (e) => log?.warn({ err: e.message }, 'conexão ociosa com o banco foi encerrada'));
  return pool;
}

// Credenciais vêm do Secrets Manager (nome do segredo em SEGREDO_DB)
export async function criarPoolDoSegredo(log?: Logger): Promise<Pool> {
  const cfg = await lerSegredo<ConfigBanco>(env('SEGREDO_DB'), log);
  return criarPool(cfg, log);
}

// Executa fn numa transação: commit se terminar, rollback se lançar erro.
export async function transacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* conexão já perdida */
    }
    throw e;
  } finally {
    c.release();
  }
}

const CODIGOS_REDE = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'];

// Erro de infraestrutura (banco fora do ar): a mensagem não tem culpa, não pode ir para a DLQ.
export function erroDeInfra(e: unknown): boolean {
  const err = e as { code?: string; message?: string; errors?: unknown[]; cause?: unknown } | undefined;
  if (!err) return false;
  const codigo = err.code ?? '';
  if (CODIGOS_REDE.includes(codigo)) return true;
  // classe 08 (falha de conexão), 53 (recursos) e 57P (banco desligando) do Postgres
  if (/^(08|53|57P)/.test(codigo)) return true;
  if (/Connection terminated|timeout exceeded when trying to connect|terminating connection|the database system is/i.test(err.message ?? '')) return true;
  if (Array.isArray(err.errors) && err.errors.some(erroDeInfra)) return true; // AggregateError
  return err.cause ? erroDeInfra(err.cause) : false;
}

const DIR_COMMONS_SQL = join(__dirname, '..', 'sql');

// Aplica as migrações SQL (as da commons e as do serviço) de forma idempotente.
// O lock de aconselhamento evita que réplicas subindo juntas migrem ao mesmo tempo.
export async function migrar(pool: Pool, dirServico?: string, log?: Logger): Promise<void> {
  for (;;) {
    try {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock(727272)');
        await c.query(
          'CREATE TABLE IF NOT EXISTS migracoes (arquivo TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())',
        );
        const origens: [string, string][] = [['commons', DIR_COMMONS_SQL]];
        if (dirServico) origens.push(['servico', dirServico]);
        for (const [origem, dir] of origens) {
          for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
            const nome = `${origem}/${arquivo}`;
            const feita = await c.query('SELECT 1 FROM migracoes WHERE arquivo = $1', [nome]);
            if (feita.rowCount) continue;
            await c.query('BEGIN');
            await c.query(readFileSync(join(dir, arquivo), 'utf8'));
            await c.query('INSERT INTO migracoes (arquivo) VALUES ($1)', [nome]);
            await c.query('COMMIT');
            log?.info({ migracao: nome }, 'migração aplicada');
          }
        }
        await c.query('SELECT pg_advisory_unlock(727272)');
        return;
      } finally {
        c.release();
      }
    } catch (e) {
      if (!erroDeInfra(e)) throw e;
      log?.warn({ err: (e as Error).message }, 'banco indisponível para migrar; tentando de novo');
      await dormir(2000);
    }
  }
}
