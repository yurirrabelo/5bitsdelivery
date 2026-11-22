import { metrics } from '@opentelemetry/api';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { Logger, transacao } from './comuns';
import { concluirEntrega } from './conclusao';
import { Deps } from './ofertas';
import { dentroDoRaio } from './geo';
import { Hub } from './hub';

export const STREAM = 'posicoes';
const GRUPO = 'processador';
const MAXLEN = 10000;
const PRECISAO_MAX_GEOFENCE_M = 100;

const gpsTotal = metrics.getMeter('delivery.entregas').createCounter('delivery_gps_posicoes_total', {
  description: 'Posições de GPS processadas',
});

export interface Ultima {
  lat: number;
  lon: number;
  ts: number;
}

export interface PosicaoEntregador {
  entregadorId: number;
  lat: number;
  lon: number;
  ts: number;
  velocidadeKmh: number | null;
  precisao: number | null;
}

// Ingestão (alta frequência): a API só valida e faz XADD; o processamento é assíncrono (grupo "processador")
export class Posicoes {
  constructor(readonly redis: Redis) {}

  async registrar(p: PosicaoEntregador): Promise<void> {
    await this.redis.xadd(
      STREAM, 'MAXLEN', '~', MAXLEN, '*',
      'entregadorId', p.entregadorId, 'lat', p.lat, 'lon', p.lon, 'ts', p.ts,
      'velocidadeKmh', p.velocidadeKmh ?? '', 'precisao', p.precisao ?? '',
    );
  }

  async ultima(entregadorId: number): Promise<(Ultima & { velocidadeKmh: number | null; pedidoId: number | null }) | null> {
    const h = await this.redis.hgetall(`entregador:${entregadorId}:ultima`);
    if (!h.lat) return null;
    return {
      lat: Number(h.lat),
      lon: Number(h.lon),
      ts: Number(h.ts),
      velocidadeKmh: h.velocidadeKmh ? Number(h.velocidadeKmh) : null,
      pedidoId: h.pedidoId ? Number(h.pedidoId) : null,
    };
  }
}

export interface OpcoesProcessador {
  redis: Redis; // conexão própria: o XREADGROUP bloqueia
  posicoes: Posicoes;
  pool: Pool;
  hub: Hub;
  deps: Deps;
  geofenceM: number;
  consumidor: string;
  log: Logger;
}

// Consumidor do grupo "processador": atualiza geo e última posição no Redis, grava o trajeto no Postgres,
// envia ao WebSocket e testa o geofence.
export async function iniciarProcessador(o: OpcoesProcessador, parar: () => boolean): Promise<void> {
  try {
    await o.redis.xgroup('CREATE', STREAM, GRUPO, '$', 'MKSTREAM');
  } catch (e) {
    if (!String(e).includes('BUSYGROUP')) throw e;
  }
  // assume o que um processador anterior (container recriado) deixou pendente
  await o.redis.xautoclaim(STREAM, GRUPO, o.consumidor, 10000, '0-0').catch(() => undefined);

  let id = '0'; // primeiro as pendentes deste consumidor, depois só as novas ('>')
  while (!parar()) {
    try {
      const lidas = (await o.redis.xreadgroup('GROUP', GRUPO, o.consumidor, 'COUNT', 50, 'BLOCK', 2000, 'STREAMS', STREAM, id)) as
        | [string, [string, string[]][]][]
        | null;
      const entradas = lidas?.[0]?.[1] ?? [];
      if (id === '0' && entradas.length === 0) id = '>';
      for (const [entradaId, campos] of entradas) {
        const f: Record<string, string> = {};
        for (let i = 0; i < campos.length; i += 2) f[campos[i]] = campos[i + 1];
        await tratarPosicao(o, {
          entregadorId: Number(f.entregadorId),
          lat: Number(f.lat),
          lon: Number(f.lon),
          ts: Number(f.ts),
          velocidadeKmh: f.velocidadeKmh ? Number(f.velocidadeKmh) : null,
          precisao: f.precisao ? Number(f.precisao) : null,
        });
        await o.redis.xack(STREAM, GRUPO, entradaId);
      }
    } catch (e) {
      o.log.warn({ err: (e as Error).message }, 'processador de posições: falha; tentando de novo');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function tratarPosicao(o: Pick<OpcoesProcessador, 'posicoes' | 'pool' | 'hub' | 'deps' | 'geofenceM'>, p: PosicaoEntregador): Promise<void> {
  const ativa = await o.pool.query(
    "SELECT pedido_id, destino_lat, destino_lon FROM entregas WHERE entregador_id = $1 AND status = 'ATRIBUIDA' LIMIT 1",
    [p.entregadorId],
  );
  const entrega = ativa.rows[0] as { pedido_id: string; destino_lat: number; destino_lon: number } | undefined;
  const pedidoId = entrega ? Number(entrega.pedido_id) : null;

  await o.posicoes.redis
    .multi()
    .geoadd('entregadores:geo', p.lon, p.lat, String(p.entregadorId))
    .hset(`entregador:${p.entregadorId}:ultima`, {
      lat: p.lat, lon: p.lon, ts: p.ts, velocidadeKmh: p.velocidadeKmh ?? '', pedidoId: pedidoId ?? '',
    })
    .exec();
  await o.pool.query(
    'INSERT INTO posicoes (entregador_id, pedido_id, lat, lon, velocidade_kmh, precisao, ts) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))',
    [p.entregadorId, pedidoId, p.lat, p.lon, p.velocidadeKmh, p.precisao, p.ts],
  );
  gpsTotal.add(1);
  o.hub.transmitir({
    type: 'posicao', entregadorId: p.entregadorId, lat: p.lat, lon: p.lon, ts: p.ts, velocidadeKmh: p.velocidadeKmh, pedidoId,
  });

  // GPS ainda procurando satélites (precisão ruim) não pode "chegar" ao destino por engano
  const precisaoBoa = p.precisao === null || p.precisao <= PRECISAO_MAX_GEOFENCE_M;
  if (entrega && pedidoId !== null && precisaoBoa && dentroDoRaio(p.lat, p.lon, entrega.destino_lat, entrega.destino_lon, o.geofenceM)) {
    const depois: (() => void)[] = [];
    await transacao(o.pool, (c) => concluirEntrega(c, pedidoId, 'geofence', o.deps, (a) => depois.push(a)));
    depois.forEach((a) => a());
  }
}
