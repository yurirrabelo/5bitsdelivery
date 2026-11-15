import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

// Dependência externa simulada: lenta e instável, controlada por variáveis de ambiente.
export interface ConfigGateway {
  latenciaMs: () => number; // GATEWAY_LATENCIA_MS
  taxaFalha: () => number; // GATEWAY_TAXA_FALHA, de 0 a 100
}

interface Resultado {
  http: number;
  corpo: Record<string, unknown>;
}

interface Cobranca {
  chave: string;
  pedidoId: number;
  requisicoes: number; // quantas vezes a chave chegou (inclui as repetidas)
  efetivas: number; // quantas vezes o dinheiro foi cobrado de verdade (a prova do F2: sempre 0 ou 1)
  promessa: Promise<Resultado>;
  resultado?: Resultado;
}

interface Estorno {
  pedidoId: number;
  requisicoes: number;
  referencia: string;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registrarRotasGateway(app: FastifyInstance, cfg: ConfigGateway): void {
  const cobrancas = new Map<string, Cobranca>();
  const estornos = new Map<number, Estorno>();

  app.get('/health', async () => ({ status: 'ok' }));

  // O resultado fica guardado por chave. Se a mesma chave chegar de novo, inclusive enquanto a primeira
  // chamada ainda está em andamento, devolve o mesmo resultado sem cobrar de novo.
  app.post('/cobrancas', async (req, reply) => {
    const chave = req.headers['idempotency-key'];
    const pedidoId = Number((req.body as { pedidoId?: unknown } | undefined)?.pedidoId);
    if (typeof chave !== 'string' || !chave) return reply.code(400).send({ erro: 'header Idempotency-Key obrigatório' });
    if (!Number.isInteger(pedidoId)) return reply.code(400).send({ erro: 'pedidoId obrigatório' });

    let c = cobrancas.get(chave);
    if (c) {
      c.requisicoes++;
    } else {
      const nova: Cobranca = { chave, pedidoId, requisicoes: 1, efetivas: 0, promessa: Promise.resolve({ http: 500, corpo: {} }) };
      nova.promessa = (async (): Promise<Resultado> => {
        await dormir(cfg.latenciaMs());
        const falha = Math.random() * 100 < cfg.taxaFalha();
        const r: Resultado = falha
          ? { http: 503, corpo: { erro: 'gateway indisponível (falha simulada)' } }
          : { http: 200, corpo: { status: 'APROVADO', referencia: `ref-${pedidoId}-${randomUUID().slice(0, 8)}` } };
        if (!falha) nova.efetivas = 1;
        nova.resultado = r;
        return r;
      })();
      cobrancas.set(chave, nova);
      c = nova;
    }
    const r = await c.promessa;
    return reply.code(r.http).send(r.corpo);
  });

  // Idempotente e sem falha simulada: a compensação não pode falhar de propósito
  app.post('/cobrancas/:pedidoId/estorno', async (req, reply) => {
    const pedidoId = Number((req.params as { pedidoId: string }).pedidoId);
    if (!Number.isInteger(pedidoId)) return reply.code(400).send({ erro: 'pedidoId inválido' });
    let e = estornos.get(pedidoId);
    if (e) e.requisicoes++;
    else {
      e = { pedidoId, requisicoes: 1, referencia: `estorno-${pedidoId}-${randomUUID().slice(0, 8)}` };
      estornos.set(pedidoId, e);
    }
    return { status: 'ESTORNADO', referencia: e.referencia };
  });

  // Cobranças e estornos por chave, com a quantidade de vezes que cada chave foi cobrada
  app.get('/cobrancas', async () => ({
    cobrancas: [...cobrancas.values()].map((c) => ({
      chave: c.chave,
      pedidoId: c.pedidoId,
      requisicoes: c.requisicoes,
      vezesCobrada: c.efetivas,
      status: c.resultado ? (c.resultado.http === 200 ? 'APROVADO' : 'FALHOU') : 'EM_ANDAMENTO',
    })),
    estornos: [...estornos.values()].map((e) => ({ pedidoId: e.pedidoId, requisicoes: e.requisicoes, referencia: e.referencia })),
  }));
}
