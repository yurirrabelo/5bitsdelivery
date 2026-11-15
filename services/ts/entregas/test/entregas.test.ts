import { Envelope, criarEnvelope, criarPool, erroDeInfra, migrar, transacao } from '@delivery/commons';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { concluirEntrega } from '../src/conclusao';
import { Deps, Ultima, aoConfirmarPedido, despacharPendentes, linkMapas } from '../src/despacho';
import { Hub } from '../src/hub';
import { Notificador, enviarPendentes } from '../src/notificacoes';
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
let ultimas: Map<number, Ultima>;
let deps: Deps;

const LOJA = { lat: -26.9194, lon: -49.0661 };
const DESTINO = { lat: -26.9, lon: -49.05 };

beforeAll(async () => {
  pool = criarPool({ host: PG.hostname, port: Number(PG.port || 5432), dbname: PG.pathname.slice(1), username: PG.username, password: PG.password });
  await migrar(pool, join(__dirname, '..', 'sql'));
});
afterAll(() => pool.end());

beforeEach(async () => {
  await pool.query('TRUNCATE entregas, posicoes, notificacoes, outbox, mensagens_processadas');
  await pool.query('DELETE FROM entregadores');
  await pool.query("INSERT INTO entregadores (id, nome, device_id) VALUES (1, 'Real', 'dev-1'), (2, 'Simulado', 'dev-2')");
  hub = new HubFalso();
  ultimas = new Map();
  deps = { pool, hub, log, ultimaPosicao: async (id) => ultimas.get(id) ?? null };
});

// ---------------------------------------------------------------- utilidades
function confirmado(pedidoId: number, opcoes: { preferido?: number | null; semDestino?: boolean } = {}): Envelope {
  return criarEnvelope('pedido.confirmado', randomUUID(), {
    pedidoId,
    origem: { nome: 'Loja', ...LOJA },
    destino: opcoes.semDestino ? null : { ...DESTINO, endereco: null },
    entregadorPreferidoId: opcoes.preferido ?? null,
  });
}

// roda o manipulador como o consumidor faz: transação + ações pós-commit
async function receberConfirmado(e: Envelope) {
  const depois: (() => void)[] = [];
  await transacao(pool, (c) => aoConfirmarPedido(deps)(c, e, log, (a) => depois.push(a)));
  depois.forEach((a) => a());
}

const entrega = async (pedidoId: number) => (await pool.query('SELECT * FROM entregas WHERE pedido_id = $1', [pedidoId])).rows[0];
const statusEntregador = async (id: number) => (await pool.query('SELECT status FROM entregadores WHERE id = $1', [id])).rows[0].status;
const saidas = async () => (await pool.query('SELECT type, payload FROM outbox ORDER BY id')).rows.map((r) => ({ type: r.type, payload: r.payload.payload }));
const textos = async () => (await pool.query('SELECT texto FROM notificacoes ORDER BY id')).rows.map((r) => r.texto as string);

// ---------------------------------------------------------------- despacho
describe('despacho', () => {
  it('pedido sem destino (QR) não vira entrega', async () => {
    await receberConfirmado(confirmado(1, { semDestino: true }));
    expect(await entrega(1)).toBeUndefined();
    expect(await saidas()).toEqual([]);
  });

  it('atribui o entregador disponível mais próximo da loja', async () => {
    ultimas.set(1, { lat: LOJA.lat + 0.05, lon: LOJA.lon, ts: Date.now() }); // longe
    ultimas.set(2, { lat: LOJA.lat + 0.001, lon: LOJA.lon, ts: Date.now() }); // perto
    await receberConfirmado(confirmado(10));

    expect(await entrega(10)).toMatchObject({ status: 'ATRIBUIDA', entregador_id: 2 });
    expect(await statusEntregador(2)).toBe('OCUPADO');
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
    expect(await saidas()).toEqual([{ type: 'entrega.atribuida', payload: { pedidoId: 10, entregadorId: 2, entregadorNome: 'Simulado' } }]);
    expect(hub.eventos).toEqual([{ type: 'entrega', evento: 'atribuida', pedidoId: 10, entregadorId: 2 }]);
  });

  it('a notificação (link do Google Maps) é gravada na mesma transação da atribuição', async () => {
    await receberConfirmado(confirmado(11));
    expect(await textos()).toEqual([`🛵 Pedido #11: ${linkMapas(DESTINO.lat, DESTINO.lon)}`]);
    expect((await textos())[0]).toContain('https://www.google.com/maps/dir/?api=1&destination=-26.9,-49.05');
  });

  it('entregador sem posição conhecida continua elegível (menor id)', async () => {
    await receberConfirmado(confirmado(12));
    expect((await entrega(12)).entregador_id).toBe(1);
  });

  it('o preferido é escolhido mesmo que o outro esteja mais perto', async () => {
    ultimas.set(1, { lat: LOJA.lat + 0.05, lon: LOJA.lon, ts: Date.now() });
    ultimas.set(2, { lat: LOJA.lat, lon: LOJA.lon, ts: Date.now() });
    await receberConfirmado(confirmado(13, { preferido: 1 }));
    expect((await entrega(13)).entregador_id).toBe(1);
  });

  it('preferido ocupado: a entrega espera por ele (PENDENTE), sem cair para o outro; ao liberar, o laço despacha', async () => {
    await pool.query("UPDATE entregadores SET status = 'OCUPADO' WHERE id = 1");
    await receberConfirmado(confirmado(14, { preferido: 1 }));
    expect((await entrega(14)).status).toBe('PENDENTE');
    expect(await statusEntregador(2)).toBe('DISPONIVEL'); // o outro estava livre e não foi usado

    expect(await despacharPendentes(deps)).toBe(0); // continua esperando
    await pool.query("UPDATE entregadores SET status = 'DISPONIVEL' WHERE id = 1");
    expect(await despacharPendentes(deps)).toBe(1);
    expect(await entrega(14)).toMatchObject({ status: 'ATRIBUIDA', entregador_id: 1 });
  });

  it('sem entregador livre fica PENDENTE e o laço atribui quando alguém volta', async () => {
    await pool.query("UPDATE entregadores SET status = 'OFFLINE'");
    await receberConfirmado(confirmado(15));
    expect((await entrega(15)).status).toBe('PENDENTE');
    expect(await saidas()).toEqual([]);

    await pool.query("UPDATE entregadores SET status = 'DISPONIVEL' WHERE id = 2");
    expect(await despacharPendentes(deps)).toBe(1);
    expect((await entrega(15)).entregador_id).toBe(2);
  });

  it('dois pedidos disputando o único entregador livre: só um recebe (UPDATE condicional)', async () => {
    await pool.query("UPDATE entregadores SET status = 'OFFLINE' WHERE id = 2");
    await Promise.all([receberConfirmado(confirmado(20)), receberConfirmado(confirmado(21))]);
    const r = await pool.query("SELECT status FROM entregas ORDER BY pedido_id");
    expect(r.rows.map((x) => x.status).sort()).toEqual(['ATRIBUIDA', 'PENDENTE']);
  });

  it('pedido.confirmado repetido não cria duas entregas', async () => {
    await receberConfirmado(confirmado(30));
    const outro = confirmado(30);
    await receberConfirmado(outro);
    expect((await pool.query('SELECT count(*)::int n FROM entregas')).rows[0].n).toBe(1);
    expect((await saidas()).filter((s) => s.type === 'entrega.atribuida')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- conclusão
describe('conclusão da entrega', () => {
  beforeEach(async () => {
    await receberConfirmado(confirmado(40, { preferido: 1 }));
    await pool.query('TRUNCATE outbox, notificacoes');
    hub.eventos = [];
  });

  const concluir = async (modo: 'geofence' | 'manual') => {
    const depois: (() => void)[] = [];
    const ok = await transacao(pool, (c) => concluirEntrega(c, 40, modo, deps, (a) => depois.push(a)));
    depois.forEach((a) => a());
    return ok;
  };

  it('conclui, libera o entregador, avisa e publica entrega.concluida', async () => {
    expect(await concluir('geofence')).toBe(true);
    expect((await entrega(40)).status).toBe('CONCLUIDA');
    expect(await statusEntregador(1)).toBe('DISPONIVEL');
    expect(await saidas()).toEqual([{ type: 'entrega.concluida', payload: { pedidoId: 40, entregadorId: 1, modo: 'geofence' } }]);
    expect(await textos()).toEqual(['✅ Pedido #40 entregue.']);
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
    await receberConfirmado(confirmado(50, { preferido: 1 }));
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

  it('posição de um entregador sem entrega ativa só atualiza o mapa', async () => {
    await tratarPosicao(base(), { entregadorId: 2, lat: DESTINO.lat, lon: DESTINO.lon, ts: Date.now(), velocidadeKmh: null, precisao: null });
    expect((await entrega(50)).status).toBe('ATRIBUIDA');
    expect((await pool.query('SELECT pedido_id FROM posicoes')).rows[0].pedido_id).toBeNull();
  });
});

// ---------------------------------------------------------------- notificações
describe('notificações (mesmo padrão da outbox)', () => {
  class Falso implements Notificador {
    enviadas: string[] = [];
    falhar = false;
    async enviar(_chat: string | null, texto: string) {
      if (this.falhar) throw new Error('telegram fora do ar');
      this.enviadas.push(texto);
    }
  }

  beforeEach(async () => {
    await pool.query("INSERT INTO notificacoes (entregador_id, pedido_id, texto) VALUES (1, 60, 'oi')");
  });

  it('envia e marca como ENVIADA', async () => {
    const n = new Falso();
    expect(await enviarPendentes(pool, n, log)).toBe(1);
    expect(n.enviadas).toEqual(['oi']);
    expect((await pool.query('SELECT status FROM notificacoes')).rows[0].status).toBe('ENVIADA');
    expect(await enviarPendentes(pool, n, log)).toBe(0);
  });

  it('falha: continua PENDENTE, conta a tentativa e adia; depois envia (não se perde)', async () => {
    const n = new Falso();
    n.falhar = true;
    expect(await enviarPendentes(pool, n, log)).toBe(0);
    const r = await pool.query("SELECT status, tentativas, proxima_tentativa > now() AS adiada FROM notificacoes");
    expect(r.rows[0]).toMatchObject({ status: 'PENDENTE', tentativas: 1, adiada: true });
    expect(await enviarPendentes(pool, n, log)).toBe(0); // ainda dentro da espera

    n.falhar = false;
    await pool.query('UPDATE notificacoes SET proxima_tentativa = now()');
    expect(await enviarPendentes(pool, n, log)).toBe(1);
    expect(n.enviadas).toEqual(['oi']);
  });
});

// ---------------------------------------------------------------- rota e S3
describe('rota', () => {
  beforeEach(async () => {
    await receberConfirmado(confirmado(70, { preferido: 1 }));
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
