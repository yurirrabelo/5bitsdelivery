import websocket from '@fastify/websocket';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { Logger, transacao } from './comuns';
import { concluirEntrega } from './conclusao';
import { Deps, aceitarEntrega, listarOfertas } from './ofertas';
import { ErroGps, lerPosicao } from './gps';
import { Hub } from './hub';
import { Posicoes } from './redis';
import { montarRota } from './rota';

export interface DepsRotas {
  pool: Pool;
  hub: Hub;
  posicoes: Posicoes;
  deps: Deps;
  log: Logger;
}

const cabecalho = (req: FastifyRequest, nome: string) => {
  const v = req.headers[nome];
  return typeof v === 'string' ? v : undefined;
};

export async function registrarRotasEntregas(app: FastifyInstance, d: DepsRotas): Promise<void> {
  await app.register(websocket);

  // ---------------------------------------------------------------- GPS do navegador do entregador
  // O entregador vem dos headers que o Nginx preenche a partir do JWT, nunca do corpo.
  app.post('/api/entregas/posicoes', async (req, reply) => {
    const entregadorId = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !entregadorId) return reply.code(403).send({ erro: 'apenas entregador' });
    let p;
    try {
      p = lerPosicao(req.body);
    } catch (e) {
      if (e instanceof ErroGps) return reply.code(400).send({ erro: e.message });
      throw e;
    }
    try {
      await d.posicoes.registrar({ entregadorId, ...p, ts: Date.now() });
    } catch {
      return reply.code(503).send({ erro: 'redis indisponível' }); // o navegador manda a próxima posição em 3 s
    }
    return reply.code(202).send({ ok: true });
  });

  // ---------------------------------------------------------------- consultas
  app.get('/api/entregas/entregadores', async (req, reply) => {
    if (cabecalho(req, 'x-user-role') !== 'operador') return reply.code(403).send({ erro: 'apenas operador' });
    return listarEntregadores(d);
  });

  // Tudo o que a página do entregador precisa: o status dele, a entrega em andamento (com o destino) e, se ele
  // estiver Disponível, os pedidos esperando um entregador que ele pode aceitar
  app.get('/api/entregas/me', async (req, reply) => {
    const id = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !id) return reply.code(403).send({ erro: 'apenas entregador' });
    const e = await d.pool.query('SELECT id, nome, status FROM entregadores WHERE id = $1', [id]);
    if (!e.rowCount) return reply.code(404).send();
    const entrega = await d.pool.query(
      "SELECT pedido_id, destino_lat, destino_lon FROM entregas WHERE entregador_id = $1 AND status = 'ATRIBUIDA' LIMIT 1", [id]);
    const en = entrega.rows[0];
    return {
      entregador: e.rows[0],
      entrega: en ? { pedidoId: Number(en.pedido_id), destino: { lat: en.destino_lat, lon: en.destino_lon } } : null,
      ofertas: e.rows[0].status === 'DISPONIVEL' ? await listarOfertas(d.pool, id) : [],
    };
  });

  // O entregador aceita um pedido da lista: o primeiro a aceitar fica com ele (UPDATE condicional)
  app.post('/api/entregas/:pedidoId/aceitar', async (req, reply) => {
    const entregadorId = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !entregadorId) return reply.code(403).send({ erro: 'apenas entregador' });
    const pedidoId = Number((req.params as { pedidoId: string }).pedidoId);
    if (!Number.isInteger(pedidoId)) return reply.code(400).send({ erro: 'pedido inválido' });
    const depois: (() => void)[] = [];
    const r = await transacao(d.pool, (c) => aceitarEntrega(c, pedidoId, entregadorId, d.deps, (a) => depois.push(a)));
    if (r === 'entregador_indisponivel') return reply.code(409).send({ erro: 'Você precisa estar Disponível e sem outra entrega para aceitar.' });
    if (r === 'entrega_indisponivel') return reply.code(409).send({ erro: 'Este pedido já foi aceito por outro entregador.' });
    depois.forEach((a) => a());
    return { pedidoId, status: 'ATRIBUIDA' };
  });

  // OCUPADO só o sistema define
  app.patch('/api/entregas/me/status', async (req, reply) => {
    const id = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !id) return reply.code(403).send({ erro: 'apenas entregador' });
    const status = (req.body as { status?: string } | undefined)?.status;
    if (status !== 'DISPONIVEL' && status !== 'OFFLINE') return reply.code(400).send({ erro: 'status deve ser DISPONIVEL ou OFFLINE' });
    const r = await d.pool.query("UPDATE entregadores SET status = $1 WHERE id = $2 AND status <> 'OCUPADO' RETURNING status", [status, id]);
    if (!r.rowCount) return reply.code(409).send({ erro: 'entregador ocupado com uma entrega' });
    return { status: r.rows[0].status };
  });

  // Conclusão manual: o entregador da entrega ou o operador
  app.post('/api/entregas/:pedidoId/confirmar', async (req, reply) => {
    const pedidoId = Number((req.params as { pedidoId: string }).pedidoId);
    const papel = cabecalho(req, 'x-user-role');
    const entregadorId = Number(cabecalho(req, 'x-entregador-id')) || null;
    const e = await d.pool.query('SELECT entregador_id, status FROM entregas WHERE pedido_id = $1', [pedidoId]);
    if (!e.rowCount) return reply.code(404).send({ erro: 'entrega não encontrada' });
    const dona = papel === 'entregador' && entregadorId !== null && entregadorId === Number(e.rows[0].entregador_id);
    if (papel !== 'operador' && !dona) return reply.code(403).send({ erro: 'sem permissão para esta entrega' });
    const depois: (() => void)[] = [];
    const ok = await transacao(d.pool, (c) => concluirEntrega(c, pedidoId, 'manual', d.deps, (a) => depois.push(a)));
    if (!ok) return reply.code(409).send({ erro: `entrega está ${e.rows[0].status}` });
    depois.forEach((a) => a());
    return { pedidoId, status: 'CONCLUIDA' };
  });

  app.get('/api/entregas/:pedidoId/rota', async (req, reply) => {
    const pedidoId = Number((req.params as { pedidoId: string }).pedidoId);
    const papel = cabecalho(req, 'x-user-role');
    const e = await d.pool.query('SELECT entregador_id FROM entregas WHERE pedido_id = $1', [pedidoId]);
    if (!e.rowCount) return reply.code(404).send({ erro: 'entrega não encontrada' });
    const dona = papel === 'entregador' && Number(cabecalho(req, 'x-entregador-id')) === Number(e.rows[0].entregador_id);
    if (papel !== 'operador' && !dona) return reply.code(403).send({ erro: 'sem permissão para esta entrega' });
    return montarRota(d.pool, pedidoId);
  });

  // ---------------------------------------------------------------- mapa ao vivo
  // O Nginx já validou o JWT (?token=) e repassa o papel; só o operador acompanha o mapa
  app.get('/ws/entregas', { websocket: true }, async (socket, req) => {
    if (cabecalho(req, 'x-user-role') !== 'operador') {
      socket.close(1008, 'apenas operador');
      return;
    }
    d.hub.adicionar(socket);
    const ativas = await d.pool.query("SELECT pedido_id, entregador_id, destino_lat, destino_lon FROM entregas WHERE status = 'ATRIBUIDA'");
    d.hub.enviar(socket, {
      type: 'snapshot',
      entregadores: await listarEntregadores(d),
      entregasAtivas: ativas.rows.map((r) => ({
        pedidoId: Number(r.pedido_id), entregadorId: r.entregador_id, destino: { lat: r.destino_lat, lon: r.destino_lon },
      })),
    });
  });
}

async function listarEntregadores(d: DepsRotas) {
  const r = await d.pool.query('SELECT id, nome, status FROM entregadores ORDER BY id');
  return Promise.all(
    r.rows.map(async (e) => ({ id: e.id, nome: e.nome, status: e.status, ultimaPosicao: await d.posicoes.ultima(e.id).catch(() => null) })),
  );
}
