import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigAuth, criarUsuario, registrarRotasAuth } from '../src/app';

const cfg: ConfigAuth = {
  segredoJwt: 'segredo-de-teste-bem-longo-para-hs256',
  expiracaoHoras: 1,
  eventoCodigo: 'codigo-do-evento',
  usuarios: [
    criarUsuario('operador', 'Operador', 'operador', null, 'senha-op'),
    criarUsuario('entregador1', 'Entregador Real', 'entregador', 1, 'senha-ent'),
  ],
};

const app = Fastify();
registrarRotasAuth(app, cfg);

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}
const validar = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/auth/validate', headers });

beforeAll(() => app.ready());

describe('login', () => {
  it('operador entra e recebe token e dados do usuário', async () => {
    const r = await login('operador', 'senha-op');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.token).toBeTruthy();
    expect(j.expiresIn).toBe(3600);
    expect(j.usuario).toEqual({ id: 'operador', nome: 'Operador', role: 'operador', entregadorId: null });
  });

  it('entregador recebe o entregadorId', async () => {
    const j = (await login('entregador1', 'senha-ent')).json();
    expect(j.usuario.role).toBe('entregador');
    expect(j.usuario.entregadorId).toBe(1);
  });

  it('erro é sempre 401 genérico: senha errada, usuário inexistente, corpo inválido', async () => {
    for (const r of [await login('operador', 'errada'), await login('fantasma', 'x'), await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ erro: 'credenciais inválidas' });
    }
  });
});

describe('sessão do cliente do QR', () => {
  it('com o código certo recebe um token de papel cliente', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/cliente', payload: { apelido: 'Zé', codigo: 'codigo-do-evento' } });
    expect(r.statusCode).toBe(200);
    const v = await validar({ authorization: `Bearer ${r.json().token}` });
    expect(v.statusCode).toBe(200);
    expect(v.headers['x-user-role']).toBe('cliente');
    expect(v.headers['x-user-id']).toMatch(/^c-/);
    expect(decodeURIComponent(String(v.headers['x-user-name']))).toBe('Zé');
  });

  it('código errado ou apelido fora de 1 a 20 caracteres: 401', async () => {
    for (const payload of [{ apelido: 'Ana', codigo: 'errado' }, { apelido: '', codigo: 'codigo-do-evento' }, { apelido: 'x'.repeat(21), codigo: 'codigo-do-evento' }]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/cliente', payload });
      expect(r.statusCode).toBe(401);
    }
  });
});

describe('/auth/validate (usado pelo auth_request do Nginx)', () => {
  it('sem token: 401', async () => {
    expect((await validar({})).statusCode).toBe(401);
  });

  it('token inválido ou de outra chave: 401', async () => {
    expect((await validar({ authorization: 'Bearer abc.def.ghi' })).statusCode).toBe(401);
    const outro = Fastify();
    registrarRotasAuth(outro, { ...cfg, segredoJwt: 'outra-chave-completamente-diferente-123' });
    const t = (await outro.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operador', password: 'senha-op' } })).json().token;
    expect((await validar({ authorization: `Bearer ${t}` })).statusCode).toBe(401);
  });

  it('token válido: devolve os headers X-User-*', async () => {
    const token = (await login('entregador1', 'senha-ent')).json().token;
    const r = await validar({ authorization: `Bearer ${token}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-user-id']).toBe('entregador1');
    expect(r.headers['x-user-role']).toBe('entregador');
    expect(r.headers['x-entregador-id']).toBe('1');
  });

  it('WebSocket: aceita o token em ?token= no X-Original-URI', async () => {
    const token = (await login('operador', 'senha-op')).json().token;
    const r = await validar({ 'x-original-uri': `/ws/entregas?token=${token}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-user-role']).toBe('operador');
  });
});

describe('rotas protegidas pelo Nginx', () => {
  it('/me devolve a identidade que veio nos headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-user-id': 'operador', 'x-user-name': 'Operador', 'x-user-role': 'operador' } });
    expect(r.json()).toEqual({ id: 'operador', nome: 'Operador', role: 'operador', entregadorId: null });
  });

  it('/evento só para operador', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/auth/evento', headers: { 'x-user-role': 'operador' } });
    expect(ok.json()).toEqual({ codigo: 'codigo-do-evento' });
    const negado = await app.inject({ method: 'GET', url: '/api/auth/evento', headers: { 'x-user-role': 'cliente' } });
    expect(negado.statusCode).toBe(403);
  });
});
