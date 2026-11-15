import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Broker } from './broker';
import { EstadoSaude } from './consumidor';

export interface DependenciasSaude {
  pool?: Pool;
  broker?: Broker;
  estado?: EstadoSaude;
  extras?: Record<string, () => Promise<boolean>>;
}

// GET /health: 200 {"status":"ok"} ou 503 se banco ou broker estiverem fora (ou o consumidor segurando mensagem)
export function registrarSaude(app: FastifyInstance, d: DependenciasSaude): void {
  app.get('/health', async (_req, reply) => {
    const falhas: string[] = [];
    if (d.pool) {
      try {
        await d.pool.query('SELECT 1');
      } catch {
        falhas.push('banco');
      }
    }
    if (d.broker && !d.broker.conectado()) falhas.push('broker');
    if (d.estado?.segurando) falhas.push('consumidor segurando mensagem');
    for (const [nome, ok] of Object.entries(d.extras ?? {})) {
      if (!(await ok().catch(() => false))) falhas.push(nome);
    }
    if (falhas.length) return reply.code(503).send({ status: 'indisponivel', falhas });
    return { status: 'ok' };
  });
}
