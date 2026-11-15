import websocket from '@fastify/websocket';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { Logger, transacao } from './comuns';
import { concluirEntrega } from './conclusao';
import { Deps, linkMapas } from './despacho';
import { distanciaM } from './geo';
import { ErroGps, parseGps, parseUrlencoded } from './gps';
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
  // o Traccar pode enviar o corpo como formulário
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, corpo, done) => {
    done(null, parseUrlencoded(String(corpo)));
  });
  await app.register(websocket);

  // device_id -> entregador (o token do dispositivo identifica o entregador no /gps)
  const dispositivos = new Map<string, { id: number; ate: number }>();
  const entregadorDoDispositivo = async (deviceId: string): Promise<number | null> => {
    const cache = dispositivos.get(deviceId);
    if (cache && cache.ate > Date.now()) return cache.id;
    const r = await d.pool.query('SELECT id FROM entregadores WHERE device_id = $1', [deviceId]);
    if (!r.rowCount) return null;
    dispositivos.set(deviceId, { id: Number(r.rows[0].id), ate: Date.now() + 30000 });
    return Number(r.rows[0].id);
  };

  // ---------------------------------------------------------------- GPS do Traccar
  app.route({
    method: ['GET', 'POST'],
    url: '/gps',
    handler: async (req, reply) => {
      d.log.debug({ query: req.query, corpo: req.body, tipo: req.headers['content-type'] }, 'gps: payload bruto');
      let p;
      try {
        p = parseGps(req.query, req.body);
      } catch (e) {
        if (e instanceof ErroGps) return reply.code(400).send({ erro: e.message });
        throw e;
      }
      const entregadorId = await entregadorDoDispositivo(p.deviceId);
      if (entregadorId === null) return reply.code(401).send({ erro: 'dispositivo desconhecido' });
      try {
        await d.posicoes.registrar({ entregadorId, lat: p.lat, lon: p.lon, ts: p.ts, velocidadeKmh: p.velocidadeKmh, precisao: p.precisao });
      } catch {
        return reply.code(503).send({ erro: 'redis indisponível' }); // o Traccar guarda a posição e reenvia
      }
      return reply.code(200).send('OK');
    },
  });

  // GPS pela PWA: o entregador vem do header (nunca do corpo)
  app.post('/api/entregas/posicoes', async (req, reply) => {
    const entregadorId = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !entregadorId) return reply.code(403).send({ erro: 'apenas entregador' });
    const c = req.body as { lat?: number; lon?: number; precisao?: number; velocidade?: number; timestamp?: unknown } | undefined;
    let p;
    try {
      // "velocidade" da PWA vem em m/s (Geolocation API); o parser trabalha com o formato JSON do Traccar
      p = parseGps({}, {
        device_id: 'pwa',
        location: { timestamp: c?.timestamp, coords: { latitude: c?.lat, longitude: c?.lon, speed: c?.velocidade, accuracy: c?.precisao } },
      });
    } catch (e) {
      if (e instanceof ErroGps) return reply.code(400).send({ erro: e.message });
      throw e;
    }
    try {
      await d.posicoes.registrar({ entregadorId, lat: p.lat, lon: p.lon, ts: p.ts, velocidadeKmh: p.velocidadeKmh, precisao: p.precisao });
    } catch {
      return reply.code(503).send({ erro: 'redis indisponível' });
    }
    return reply.code(202).send({ ok: true });
  });

  // ---------------------------------------------------------------- consultas
  app.get('/api/entregas/entregadores', async (req, reply) => {
    if (cabecalho(req, 'x-user-role') !== 'operador') return reply.code(403).send({ erro: 'apenas operador' });
    return listarEntregadores(d);
  });

  app.get('/api/entregas/me', async (req, reply) => {
    const id = Number(cabecalho(req, 'x-entregador-id'));
    if (cabecalho(req, 'x-user-role') !== 'entregador' || !id) return reply.code(403).send({ erro: 'apenas entregador' });
    const e = await d.pool.query('SELECT id, nome, status FROM entregadores WHERE id = $1', [id]);
    if (!e.rowCount) return reply.code(404).send();
    const entrega = await d.pool.query(
      "SELECT pedido_id, destino_lat, destino_lon FROM entregas WHERE entregador_id = $1 AND status = 'ATRIBUIDA' LIMIT 1", [id]);
    const ultima = await d.posicoes.ultima(id).catch(() => null);
    const en = entrega.rows[0];
    return {
      entregador: e.rows[0],
      entrega: en
        ? {
            pedidoId: Number(en.pedido_id),
            destino: { lat: en.destino_lat, lon: en.destino_lon },
            linkMapas: linkMapas(en.destino_lat, en.destino_lon),
            distanciaM: ultima ? Math.round(distanciaM(ultima.lat, ultima.lon, en.destino_lat, en.destino_lon)) : null,
          }
        : null,
      ultimaPosicao: ultima,
    };
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
