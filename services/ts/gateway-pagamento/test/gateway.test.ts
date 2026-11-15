import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registrarRotasGateway } from '../src/app';

function novoGateway(latenciaMs = 0, taxaFalha = 0) {
  const cfg = { latenciaMs: () => latenciaMs, taxaFalha: () => taxaFalha };
  const app = Fastify();
  registrarRotasGateway(app, cfg);
  return { app, cfg, set: (l: number, t: number) => { latenciaMs = l; taxaFalha = t; } };
}

const cobrar = (app: ReturnType<typeof Fastify>, pedidoId: number, chave = String(pedidoId)) =>
  app.inject({ method: 'POST', url: '/cobrancas', headers: { 'idempotency-key': chave }, payload: { pedidoId } });

describe('gateway simulado', () => {
  it('aprova e devolve uma referência', async () => {
    const { app } = novoGateway();
    const r = await cobrar(app, 1);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('APROVADO');
    expect(r.json().referencia).toMatch(/^ref-1-/);
  });

  it('exige o header Idempotency-Key', async () => {
    const { app } = novoGateway();
    const r = await app.inject({ method: 'POST', url: '/cobrancas', payload: { pedidoId: 1 } });
    expect(r.statusCode).toBe(400);
  });

  it('GATEWAY_TAXA_FALHA=100: toda cobrança falha com 503', async () => {
    const { app } = novoGateway(0, 100);
    const r = await cobrar(app, 1);
    expect(r.statusCode).toBe(503);
  });

  it('GATEWAY_TAXA_FALHA=0: nunca falha', async () => {
    const { app } = novoGateway(0, 0);
    for (let i = 1; i <= 30; i++) expect((await cobrar(app, i)).statusCode).toBe(200);
  });

  it('a falha segue a proporção configurada', async () => {
    const { app } = novoGateway(0, 50);
    let falhas = 0;
    for (let i = 1; i <= 400; i++) if ((await cobrar(app, i)).statusCode === 503) falhas++;
    expect(falhas).toBeGreaterThan(140);
    expect(falhas).toBeLessThan(260);
  });

  it('GATEWAY_LATENCIA_MS: a resposta demora o configurado', async () => {
    const { app } = novoGateway(150);
    const inicio = Date.now();
    await cobrar(app, 1);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(140);
  });
});

describe('idempotência (F2)', () => {
  it('a mesma chave devolve o mesmo resultado e cobra uma vez só', async () => {
    const { app } = novoGateway();
    const a = await cobrar(app, 7);
    const b = await cobrar(app, 7);
    expect(b.json().referencia).toBe(a.json().referencia);
    const lista = (await app.inject({ method: 'GET', url: '/cobrancas' })).json();
    expect(lista.cobrancas).toHaveLength(1);
    expect(lista.cobrancas[0]).toMatchObject({ pedidoId: 7, requisicoes: 2, vezesCobrada: 1, status: 'APROVADO' });
  });

  it('chamadas simultâneas com a mesma chave, com a primeira ainda em andamento: uma cobrança só', async () => {
    const { app } = novoGateway(200);
    const [a, b, c] = await Promise.all([cobrar(app, 9), cobrar(app, 9), cobrar(app, 9)]);
    expect(new Set([a.json().referencia, b.json().referencia, c.json().referencia]).size).toBe(1);
    const lista = (await app.inject({ method: 'GET', url: '/cobrancas' })).json();
    expect(lista.cobrancas[0]).toMatchObject({ requisicoes: 3, vezesCobrada: 1 });
  });

  it('chaves diferentes são cobranças diferentes', async () => {
    const { app } = novoGateway();
    await cobrar(app, 1);
    await cobrar(app, 2);
    const lista = (await app.inject({ method: 'GET', url: '/cobrancas' })).json();
    expect(lista.cobrancas.map((c: { vezesCobrada: number }) => c.vezesCobrada)).toEqual([1, 1]);
  });

  it('o resultado de uma falha também fica guardado por chave', async () => {
    const { app, set } = novoGateway(0, 100);
    expect((await cobrar(app, 3)).statusCode).toBe(503);
    set(0, 0);
    expect((await cobrar(app, 3)).statusCode).toBe(503); // mesma chave: mesmo resultado
    expect((await cobrar(app, 4)).statusCode).toBe(200); // outra chave: nova tentativa
  });
});

describe('estorno', () => {
  it('é idempotente e não sofre a falha simulada', async () => {
    const { app } = novoGateway(0, 100);
    const a = await app.inject({ method: 'POST', url: '/cobrancas/5/estorno' });
    const b = await app.inject({ method: 'POST', url: '/cobrancas/5/estorno' });
    expect(a.statusCode).toBe(200);
    expect(b.json().referencia).toBe(a.json().referencia);
    const lista = (await app.inject({ method: 'GET', url: '/cobrancas' })).json();
    expect(lista.estornos).toEqual([expect.objectContaining({ pedidoId: 5, requisicoes: 2 })]);
  });
});
