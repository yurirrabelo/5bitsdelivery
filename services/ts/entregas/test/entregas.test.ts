import { Envelope, criarEnvelope, criarPool, erroDeInfra, migrar, transacao } from '@delivery/commons';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { concluirEntrega } from '../src/conclusao';
import { Deps, aceitarEntrega, aoConfirmarPedido, listarOfertas } from '../src/ofertas';
import { Hub } from '../src/hub';
import { Posicoes, tratarPosicao } from '../src/redis';
import { exportarPendentes, montarRota } from '../src/rota';

const log = pino({ level: 'silent' });
const PG = new URL(process.env.TEST_PG_URL ?? 'postgres://teste:teste@localhost:5432/teste');

class HubFalso extends Hub {
  eventos: any[] = [];
  override transmitir(msg: object) {
    this.eventos.push(msg);
  }
}

let pool: Pool;
let hub: HubFalso;
let deps: Deps;

const LOJA = { lat: -26.9194, lon: -49.0661 };
const DESTINO = { lat: -26.9, lon: -49.05 };

beforeAll(async () => {
  pool = criarPool({ host: PG.hostname, port: Number(PG.port || 5432), dbname: PG.pathname.slice(1), username: PG.username, password: PG.password });
  await migrar(pool, join(__dirname, '..', 'sql'));
});
afterAll(() => pool.end());

beforeEach(async () => {
  await pool.query('TRUNCATE entregas, posicoes, outbox, mensagens_processadas');
  await pool.query('DELETE FROM entregadores');
  // dois entregadores só nos testes: é o que permite provar a disputa pelo mesmo pedido
  await pool.query("INSERT INTO entregadores (id, nome) VALUES (1, 'Ana'), (2, 'Bia')");
  hub = new HubFalso();
  deps = { pool, hub, log };
});

// ---------------------------------------------------------------- utilidades
function confirmado(pedidoId: number, opcoes: { preferido?: number | null; semDestino?: boolean; versao?: 1 | 2 } = {}): Envelope {
  const destino = opcoes.semDestino ? null : { ...DESTINO, endereco: null };
  const preferido = opcoes.preferido ?? null;
  const origem = { nome: 'Loja', ...LOJA };
  // v1: destino e entregadorPreferidoId no payload. v2 (a que o pedidos publica): dentro de "entrega".
  return opcoes.versao === 1
    ? criarEnvelope('pedido.confirmado', randomUUID(), { pedidoId, origem, destino, entregadorPreferidoId: preferido }, 1)
    : criarEnvelope('pedido.confirmado', randomUUID(), { pedidoId, origem, entrega: { destino, entregadorPreferidoId: preferido } }, 2);
}

// roda o manipulador como o consumidor faz: transação + ações pós-commit
async function receberConfirmado(e: Envelope) {
  const depois: (() => void)[] = [];
  await transacao(pool, (c) => aoConfirmarPedido(deps)(c, e, log, (a) => depois.push(a)));
  depois.forEach((a) => a());
}

// o entregador toca em "Aceitar"
async function aceitar(pedidoId: number, entregadorId: number) {
  const depois: (() => void)[] = [];
  const r = await transacao(pool, (c) => aceitarEntrega(c, pedidoId, entregadorId, deps, (a) => depois.push(a)));
  if (r === 'aceita') depois.forEach((a) => a());
  return r;
}

const entrega = async (pedidoId: number) => (await pool.query('SELECT * FROM entregas WHERE pedido_id = $1', [pedidoId])).rows[0];
const statusEntregador = async (id: number) => (await pool.query('SELECT status FROM entregadores WHERE id = $1', [id])).rows[0].status;
const saidas = async () => (await pool.query('SELECT type, payload FROM outbox ORDER BY id')).rows.map((r) => ({ type: r.type, payload: r.payload.payload }));

// ---------------------------------------------------------------- oferta e aceite
describe('oferta e aceite do pedido', () => {
  it('pedido sem endereço de entrega (QR sem GPS) não vira entrega', async () => {
    await receberConfirmado(confirmado(1, { semDestino: true }));
    expect(await entrega(1)).toBeUndefined();
    expect(await saidas()).toEqual([]);
  });

  it('pedido com endereço vira entrega PENDENTE: o sistema NÃO escolhe entregador sozinho', async () => {
    await receberConfirmado(confirmado(10));
    expect(await entrega(10)).toMatchObject({ status: 'PENDENTE', entregador_id: null, destino_lat: DESTINO.lat, destino_lon: DESTINO.lon });
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
    expect(await statusEntregador(2)).toBe('DISPONIVEL');
    expect(await saidas()).toEqual([]);
    expect(hub.eventos).toEqual([{ type: 'entrega', evento: 'pendente', pedidoId: 10 }]);
  });

  it('a oferta aparece para os dois entregadores, a mais antiga primeiro', async () => {
    await receberConfirmado(confirmado(11));
    await receberConfirmado(confirmado(12));
    for (const id of [1, 2]) {
      expect(await listarOfertas(pool, id)).toEqual([
        { pedidoId: 11, destino: DESTINO },
        { pedidoId: 12, destino: DESTINO },
      ]);
    }
  });

  it('o entregador aceita: a entrega é dele, ele fica Ocupado e o pedido recebe entrega.atribuida', async () => {
    await receberConfirmado(confirmado(20));
    hub.eventos = [];
    expect(await aceitar(20, 2)).toBe('aceita');

    expect(await entrega(20)).toMatchObject({ status: 'ATRIBUIDA', entregador_id: 2 });
    expect(await statusEntregador(2)).toBe('OCUPADO');
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
    expect(await saidas()).toEqual([{ type: 'entrega.atribuida', payload: { pedidoId: 20, entregadorId: 2, entregadorNome: 'Bia' } }]);
    expect(hub.eventos).toEqual([{ type: 'entrega', evento: 'atribuida', pedidoId: 20, entregadorId: 2 }]);
    expect(await listarOfertas(pool, 1)).toEqual([]); // a oferta sumiu para o outro
  });

  it('dois entregadores aceitam o mesmo pedido ao mesmo tempo: só um fica com ele', async () => {
    await receberConfirmado(confirmado(21));
    const resultados = await Promise.all([aceitar(21, 1), aceitar(21, 2)]);
    expect([...resultados].sort()).toEqual(['aceita', 'entrega_indisponivel']);
    expect((await saidas()).filter((s) => s.type === 'entrega.atribuida')).toHaveLength(1);
    const ocupados = (await pool.query("SELECT count(*)::int n FROM entregadores WHERE status = 'OCUPADO'")).rows[0].n;
    expect(ocupados).toBe(1); // o que perdeu continua Disponível
  });

  it('aceitar de novo um pedido que já foi aceito: indisponível, sem mudar nada', async () => {
    await receberConfirmado(confirmado(22));
    expect(await aceitar(22, 1)).toBe('aceita');
    expect(await aceitar(22, 2)).toBe('entrega_indisponivel');
    expect((await entrega(22)).entregador_id).toBe(1);
    expect(await statusEntregador(2)).toBe('DISPONIVEL');
  });

  it('pedido feito para um entregador (preferido): só ele vê e aceita', async () => {
    await receberConfirmado(confirmado(23, { preferido: 1 }));
    expect(await listarOfertas(pool, 2)).toEqual([]);
    expect(await listarOfertas(pool, 1)).toHaveLength(1);
    expect(await aceitar(23, 2)).toBe('entrega_indisponivel');
    expect((await entrega(23)).status).toBe('PENDENTE');
    expect(await statusEntregador(2)).toBe('DISPONIVEL');
    expect(await aceitar(23, 1)).toBe('aceita');
  });

  it('entregador Offline não aceita: a entrega continua esperando e nada muda', async () => {
    await pool.query("UPDATE entregadores SET status = 'OFFLINE' WHERE id = 1");
    await receberConfirmado(confirmado(24));
    expect(await aceitar(24, 1)).toBe('entregador_indisponivel');
    expect((await entrega(24)).status).toBe('PENDENTE');
    expect(await statusEntregador(1)).toBe('OFFLINE');
    expect(await saidas()).toEqual([]);
  });

  it('um entregador só aceita um pedido por vez (fica Ocupado até concluir)', async () => {
    await receberConfirmado(confirmado(25));
    await receberConfirmado(confirmado(26));
    expect(await aceitar(25, 1)).toBe('aceita');
    expect(await aceitar(26, 1)).toBe('entregador_indisponivel');
    expect((await entrega(26)).status).toBe('PENDENTE');
    expect(await aceitar(26, 2)).toBe('aceita'); // o outro entregador pode
  });

  it('aceitar um pedido que não existe: indisponível', async () => {
    expect(await aceitar(999, 1)).toBe('entrega_indisponivel');
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
  });

  it('versionamento: entende pedido.confirmado v1 e v2 (converte a v1 ao ler)', async () => {
    await receberConfirmado(confirmado(31, { versao: 1, preferido: 1 }));
    await receberConfirmado(confirmado(32, { versao: 2, preferido: 2 }));
    expect(await entrega(31)).toMatchObject({ status: 'PENDENTE', entregador_preferido_id: 1, destino_lat: DESTINO.lat, destino_lon: DESTINO.lon });
    expect(await entrega(32)).toMatchObject({ status: 'PENDENTE', entregador_preferido_id: 2, destino_lat: DESTINO.lat, destino_lon: DESTINO.lon });
  });

  it('v1 e v2 sem endereço (QR) também não viram entrega', async () => {
    await receberConfirmado(confirmado(33, { versao: 1, semDestino: true }));
    await receberConfirmado(confirmado(34, { versao: 2, semDestino: true }));
    expect((await pool.query('SELECT count(*)::int n FROM entregas')).rows[0].n).toBe(0);
  });

  it('pedido.confirmado repetido não cria duas entregas nem duas ofertas', async () => {
    await receberConfirmado(confirmado(30));
    await receberConfirmado(confirmado(30));
    expect((await pool.query('SELECT count(*)::int n FROM entregas')).rows[0].n).toBe(1);
    expect(await listarOfertas(pool, 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- conclusão
describe('conclusão da entrega', () => {
  beforeEach(async () => {
    await receberConfirmado(confirmado(40));
    await aceitar(40, 1);
    await pool.query('TRUNCATE outbox');
    hub.eventos = [];
  });

  const concluir = async (modo: 'geofence' | 'manual') => {
    const depois: (() => void)[] = [];
    const ok = await transacao(pool, (c) => concluirEntrega(c, 40, modo, deps, (a) => depois.push(a)));
    depois.forEach((a) => a());
    return ok;
  };

  it('conclui, libera o entregador e publica entrega.concluida', async () => {
    expect(await concluir('geofence')).toBe(true);
    expect((await entrega(40)).status).toBe('CONCLUIDA');
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
    expect(await saidas()).toEqual([{ type: 'entrega.concluida', payload: { pedidoId: 40, entregadorId: 1, modo: 'geofence' } }]);
    expect(hub.eventos).toEqual([{ type: 'entrega', evento: 'concluida', pedidoId: 40, entregadorId: 1 }]);
  });

  it('só conclui uma vez (geofence e botão ao mesmo tempo)', async () => {
    const [a, b] = await Promise.all([concluir('geofence'), concluir('manual')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await saidas()).toHaveLength(1);
  });

  it('o evento herda o correlationId do pedido', async () => {
    await concluir('manual');
    const r = await pool.query('SELECT payload FROM outbox');
    expect(r.rows[0].payload.correlationId).toBe((await entrega(40)).correlation_id);
  });

  it('depois de concluir o entregador volta a receber ofertas', async () => {
    await receberConfirmado(confirmado(41));
    expect(await aceitar(41, 1)).toBe('entregador_indisponivel'); // ainda ocupado com o #40
    await concluir('manual');
    expect(await aceitar(41, 1)).toBe('aceita');
  });
});

// ---------------------------------------------------------------- posições e geofence
describe('processamento das posições', () => {
  const posicoesFalsas = {
    redis: { multi: () => ({ geoadd() { return this; }, hset() { return this; }, async exec() { return []; } }) },
    ultima: async () => null,
  } as unknown as Posicoes;
  const base = () => ({ posicoes: posicoesFalsas, pool, hub, deps, geofenceM: 50 });
  const metro = 1 / 111195;

  beforeEach(async () => {
    await receberConfirmado(confirmado(50));
    await aceitar(50, 1);
    hub.eventos = [];
  });

  it('posição longe do destino: grava o trajeto e envia ao mapa, sem concluir', async () => {
    await tratarPosicao(base(), { entregadorId: 1, lat: DESTINO.lat + 500 * metro, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: 30, precisao: 5 });
    expect((await entrega(50)).status).toBe('ATRIBUIDA');
    expect((await pool.query('SELECT pedido_id FROM posicoes')).rows[0].pedido_id).toBe('50');
    expect(hub.eventos[0]).toMatchObject({ type: 'posicao', entregadorId: 1, pedidoId: 50, velocidadeKmh: 30 });
  });

  it('posição a menos de GEOFENCE_RAIO_M do destino conclui a entrega', async () => {
    await tratarPosicao(base(), { entregadorId: 1, lat: DESTINO.lat + 30 * metro, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: 5, precisao: 5 });
    expect((await entrega(50)).status).toBe('CONCLUIDA');
    expect((await saidas()).find((s) => s.type === 'entrega.concluida')?.payload).toMatchObject({ modo: 'geofence' });
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
  });

  it('GPS com precisão ruim (ainda procurando satélites) perto do destino NÃO conclui a entrega', async () => {
    await tratarPosicao(base(), { entregadorId: 1, lat: DESTINO.lat + 10 * metro, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: null, precisao: 800 });
    expect((await entrega(50)).status).toBe('ATRIBUIDA');
    await tratarPosicao(base(), { entregadorId: 1, lat: DESTINO.lat + 10 * metro, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: null, precisao: 12 });
    expect((await entrega(50)).status).toBe('CONCLUIDA');
  });

  it('posição de um entregador sem entrega ativa só atualiza o mapa', async () => {
    await tratarPosicao(base(), { entregadorId: 2, lat: DESTINO.lat, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: null, precisao: null });
    expect((await entrega(50)).status).toBe('ATRIBUIDA');
    expect((await pool.query('SELECT pedido_id FROM posicoes')).rows[0].pedido_id).toBeNull();
  });
});

// ---------------------------------------------------------------- rota e S3
describe('rota', () => {
  beforeEach(async () => {
    await receberConfirmado(confirmado(70));
    for (const [i, p] of [[-26.91, -49.07], [-26.905, -49.06], [-26.9, -49.05]].entries()) {
      await pool.query('INSERT INTO posicoes (entregador_id, pedido_id, lat, lon, ts) VALUES (1, 70, $1, $2, now() + make_interval(secs => $3))', [p[0], p[1], i]);
    }
    await pool.query("UPDATE entregas SET status = 'CONCLUIDA', concluida_em = now() WHERE pedido_id = 70");
  });

  it('LineString em [lon, lat], na ordem do tempo', async () => {
    const r = await montarRota(pool, 70);
    expect(r.geometry.type).toBe('LineString');
    expect(r.geometry.coordinates).toEqual([[-49.07, -26.91], [-49.06, -26.905], [-49.05, -26.9]]);
  });

  it('exporta para rotas/pedido-<id>.geojson e marca como exportada', async () => {
    const enviados: any[] = [];
    const s3 = { send: async (cmd: any) => void enviados.push(cmd.input) } as any;
    expect(await exportarPendentes(pool, s3, 'delivery-rotas', log)).toBe(1);
    expect(enviados[0]).toMatchObject({ Bucket: 'delivery-rotas', Key: 'rotas/pedido-70.geojson' });
    expect(JSON.parse(enviados[0].Body).geometry.coordinates).toHaveLength(3);
    expect((await entrega(70)).rota_exportada).toBe(true);
    expect(await exportarPendentes(pool, s3, 'delivery-rotas', log)).toBe(0);
  });

  it('S3 fora do ar: a exportação fica pendente e é refeita depois', async () => {
    const fora = { send: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } } as any;
    expect(await exportarPendentes(pool, fora, 'delivery-rotas', log)).toBe(0);
    expect((await entrega(70)).rota_exportada).toBe(false);
    expect(erroDeInfra({ code: 'ECONNREFUSED' })).toBe(true);

    const ok = { send: async () => undefined } as any;
    expect(await exportarPendentes(pool, ok, 'delivery-rotas', log)).toBe(1);
    expect((await entrega(70)).rota_exportada).toBe(true);
  });
});
