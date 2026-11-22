import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { registrarRotasEntregas } from '../src/app';
import { Hub } from '../src/hub';
import { Posicoes } from '../src/redis';

// GPS do navegador: POST /api/entregas/posicoes. Sem banco: só a API, com o Redis falso.
const log = pino({ level: 'silent' });

async function montar(registrar: (p: any) => Promise<void> = async () => undefined) {
  const recebidas: any[] = [];
  const posicoes = {
    registrar: async (p: any) => {
      recebidas.push(p);
      await registrar(p);
    },
    ultima: async () => null,
  } as unknown as Posicoes;
  const app = Fastify();
  await registrarRotasEntregas(app, { pool: {} as any, hub: new Hub(), posicoes, deps: {} as any, log });
  return { app, recebidas };
}

const entregador = { 'x-user-role': 'entregador', 'x-entregador-id': '1' };

describe('POST /api/entregas/posicoes', () => {
  it('o entregador envia a posição: 202, e o servidor guarda com o id do JWT e o horário dele', async () => {
    const { app, recebidas } = await montar();
    const antes = Date.now();
    const r = await app.inject({ method: 'POST', url: '/api/entregas/posicoes', headers: entregador, payload: { lat: -26.9, lon: -49.06, precisao: 8, velocidade: 10 } });
    expect(r.statusCode).toBe(202);
    expect(recebidas).toHaveLength(1);
    expect(recebidas[0]).toMatchObject({ entregadorId: 1, lat: -26.9, lon: -49.06, precisao: 8 });
    expect(recebidas[0].velocidadeKmh).toBeCloseTo(36, 5); // 10 m/s
    expect(recebidas[0].ts).toBeGreaterThanOrEqual(antes);
  });

  it('o entregador vem do header: um id ou horário no corpo é ignorado', async () => {
    const { app, recebidas } = await montar();
    await app.inject({ method: 'POST', url: '/api/entregas/posicoes', headers: entregador, payload: { lat: 1, lon: 2, entregadorId: 2, ts: 1 } });
    expect(recebidas[0].entregadorId).toBe(1);
    expect(recebidas[0].ts).toBeGreaterThan(1_000_000_000_000);
  });

  it('operador, cliente ou sem login: 403 e nada é guardado', async () => {
    const { app, recebidas } = await montar();
    for (const headers of [{ 'x-user-role': 'operador' }, { 'x-user-role': 'cliente' }, {}]) {
      const r = await app.inject({ method: 'POST', url: '/api/entregas/posicoes', headers, payload: { lat: 1, lon: 2 } });
      expect(r.statusCode).toBe(403);
    }
    expect(recebidas).toHaveLength(0);
  });

  it('coordenadas inválidas: 400', async () => {
    const { app, recebidas } = await montar();
    for (const payload of [{ lat: 91, lon: 0 }, { lat: 0 }, {}, { lat: 'abc', lon: 1 }]) {
      const r = await app.inject({ method: 'POST', url: '/api/entregas/posicoes', headers: entregador, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(recebidas).toHaveLength(0);
  });

  it('aceitar pedido: só entregador (403 para operador, cliente ou sem login)', async () => {
    const { app } = await montar();
    for (const headers of [{ 'x-user-role': 'operador' }, { 'x-user-role': 'cliente' }, {}]) {
      const r = await app.inject({ method: 'POST', url: '/api/entregas/12/aceitar', headers });
      expect(r.statusCode).toBe(403);
    }
  });

  it('aceitar pedido com número inválido: 400', async () => {
    const { app } = await montar();
    const r = await app.inject({ method: 'POST', url: '/api/entregas/abc/aceitar', headers: entregador });
    expect(r.statusCode).toBe(400);
  });

  it('Redis fora do ar: 503 (a página tenta de novo em 3 s)', async () => {
    const { app } = await montar(async () => {
      throw new Error('redis fora');
    });
    const r = await app.inject({ method: 'POST', url: '/api/entregas/posicoes', headers: entregador, payload: { lat: 1, lon: 2 } });
    expect(r.statusCode).toBe(503);
  });
});
