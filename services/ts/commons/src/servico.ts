import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Broker } from './broker';
import { env } from './config';
import { EstadoSaude } from './consumidor';
import { ValidadorContratos } from './contratos';
import { criarPoolDoSegredo, migrar } from './db';
import { Logger, criarLogger } from './logger';
import { PublicadorOutbox } from './outbox';
import { lerSegredo } from './segredos';

export interface InfraServico {
  log: Logger;
  pool: Pool;
  broker: Broker;
  estado: EstadoSaude;
  validador: ValidadorContratos;
  publicador: PublicadorOutbox;
}

// Monta o que todo serviço com banco e mensageria precisa: segredos, banco migrado,
// conexão com o RabbitMQ, validador de contratos e publicador da outbox (já rodando).
export async function iniciarInfra(servico: string, migracoesDir?: string): Promise<InfraServico> {
  const log = criarLogger(servico);
  const pool = await criarPoolDoSegredo(log);
  await migrar(pool, migracoesDir, log);
  const { url } = await lerSegredo<{ url: string }>(env('SEGREDO_RABBITMQ'), log);
  const broker = new Broker(url, log);
  const validador = new ValidadorContratos();
  const publicador = new PublicadorOutbox(pool, broker, log, { exchange: env('RABBITMQ_EXCHANGE') });
  publicador.iniciar();
  return { log, pool, broker, estado: new EstadoSaude(), validador, publicador };
}

export function criarApp(log: Logger): FastifyInstance {
  return Fastify({ loggerInstance: log, disableRequestLogging: true }) as unknown as FastifyInstance;
}
