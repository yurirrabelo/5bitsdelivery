import { FastifyInstance } from 'fastify';
import { Armazem } from './armazem';
import { projetar } from './visao';

const cabecalho = (req: { headers: Record<string, unknown> }, nome: string) => {
  const v = req.headers[nome];
  return typeof v === 'string' ? v : undefined;
};

// A leitura do CQRS: GET /api/consultas/pedidos/{id} serve a página do cliente e a lista do painel.
// A escrita continua no pedidos (Postgres). Aqui é só leitura, de uma visão eventualmente consistente.
export function registrarRotasConsultas(app: FastifyInstance, armazem: Armazem, extrasSaude: () => Promise<boolean> = async () => true): void {
  app.get('/health', async (_req, reply) => ((await extrasSaude().catch(() => false)) ? { status: 'ok' } : reply.code(503).send({ status: 'indisponivel' })));

  app.get('/api/consultas/pedidos/:id', async (req, reply) => {
    const userId = cabecalho(req, 'x-user-id');
    const papel = cabecalho(req, 'x-user-role');
    if (!userId || !papel) return reply.code(401).send();
    if (papel !== 'operador' && papel !== 'cliente') return reply.code(403).send({ erro: 'sem permissão' });
    const item = await armazem.ler(Number((req.params as { id: string }).id));
    // o cliente só vê os próprios pedidos; pedido alheio ou ainda sem visão = 404 (a visão pode atrasar alguns ms)
    if (!item || (papel === 'cliente' && item.clienteId !== userId)) return reply.code(404).send({ erro: 'pedido não encontrado (a visão pode estar atrasada)' });
    return projetar(item);
  });

  app.get('/api/consultas/pedidos', async (req, reply) => {
    const papel = cabecalho(req, 'x-user-role');
    if (!cabecalho(req, 'x-user-id') || !papel) return reply.code(401).send();
    if (papel !== 'operador') return reply.code(403).send({ erro: 'apenas operador' });
    return (await armazem.listar(50)).map(projetar);
  });
}
