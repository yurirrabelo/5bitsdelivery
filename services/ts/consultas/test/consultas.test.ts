import { criarEnvelope } from '@delivery/commons';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { registrarRotasConsultas } from '../src/app';
import { ArmazemMemoria } from '../src/armazem';
import { projetar } from '../src/visao';

const corr = randomUUID();
const msg = (type: string, payload: object, version = 1) => criarEnvelope(type, corr, payload, version);
const reservar = (id: number, clienteId = 'c-1') => msg('estoque.reservar', { pedidoId: id, clienteId });
const origem = { lat: -26.9, lon: -49.0 };

let armazem: ArmazemMemoria;
beforeEach(() => {
  armazem = new ArmazemMemoria();
});

describe('visão do pedido (projeção da linha do tempo)', () => {
  it('o caminho feliz até ENTREGUE, com o destino da v2 e o entregador', async () => {
    const destino = { lat: -26.91, lon: -49.07 };
    for (const e of [
      reservar(1),
      msg('estoque.reservado', { pedidoId: 1 }),
      msg('pagamento.cobrar', { pedidoId: 1, expiraEm: new Date().toISOString() }),
      msg('pagamento.aprovado', { pedidoId: 1, referencia: 'ref' }),
      msg('pedido.confirmado', { pedidoId: 1, origem, entrega: { destino, entregadorPreferidoId: null } }, 2),
      msg('entrega.atribuida', { pedidoId: 1, entregadorId: 2, entregadorNome: 'Sim' }),
      msg('entrega.concluida', { pedidoId: 1, entregadorId: 2, modo: 'geofence' }),
    ]) await armazem.registrar(e);

    const v = projetar((await armazem.ler(1))!);
    expect(v).toMatchObject({ id: 1, status: 'ENTREGUE', destino, entregadorId: 2, consistencia: 'eventual' });
    expect(v.linhaDoTempo.map((p) => p.passo)).toEqual([
      'Pedido recebido', 'Unidade reservada', 'Cobrança enviada', 'Pagamento aprovado', 'Pedido confirmado', 'Entregador a caminho', 'Entrega concluída',
    ]);
  });

  it('entende pedido.confirmado v1 (destino no payload)', async () => {
    const destino = { lat: -26.91, lon: -49.07 };
    await armazem.registrar(reservar(2));
    await armazem.registrar(msg('pedido.confirmado', { pedidoId: 2, origem, destino, entregadorPreferidoId: 1 }, 1));
    expect(projetar((await armazem.ler(2))!)).toMatchObject({ status: 'CONFIRMADO', destino });
  });

  it('compensações: cancelado com motivo e depois estornado', async () => {
    await armazem.registrar(reservar(3));
    await armazem.registrar(msg('estoque.reservado', { pedidoId: 3 }));
    await armazem.registrar(msg('pedido.cancelado', { pedidoId: 3, motivo: 'PRAZO_EXPIRADO' }));
    expect(projetar((await armazem.ler(3))!)).toMatchObject({ status: 'CANCELADO', motivo: 'PRAZO_EXPIRADO' });
    await armazem.registrar(msg('pagamento.estornado', { pedidoId: 3 }));
    expect(projetar((await armazem.ler(3))!).status).toBe('ESTORNADO');
  });

  it('esgotado', async () => {
    await armazem.registrar(reservar(4));
    await armazem.registrar(msg('estoque.esgotado', { pedidoId: 4 }));
    expect(projetar((await armazem.ler(4))!).status).toBe('ESGOTADO');
  });

  it('mensagens fora de ordem: vale o passo mais avançado (a visão é eventualmente consistente)', async () => {
    await armazem.registrar(msg('entrega.atribuida', { pedidoId: 5, entregadorId: 1, entregadorNome: 'x' }));
    await armazem.registrar(reservar(5)); // chegou atrasada
    expect(projetar((await armazem.ler(5))!).status).toBe('EM_ENTREGA');
  });

  it('idempotência: o mesmo messageId duas vezes tem um efeito só', async () => {
    const e = reservar(6);
    expect(await armazem.registrar(e)).toBe('processada');
    expect(await armazem.registrar(e)).toBe('duplicada');
    expect((await armazem.ler(6))!.eventos).toHaveLength(1);
  });
});

describe('API de leitura', () => {
  const operador = { 'x-user-id': 'operador', 'x-user-role': 'operador' };

  const nova = (a: ArmazemMemoria) => {
    const f = Fastify();
    registrarRotasConsultas(f, a);
    return f;
  };

  it('operador lê qualquer pedido; o cliente só o próprio (outro cliente: 404)', async () => {
    const f = nova(armazem);
    await armazem.registrar(reservar(10, 'c-1'));
    const ok = await f.inject({ method: 'GET', url: '/api/consultas/pedidos/10', headers: { 'x-user-id': 'c-1', 'x-user-role': 'cliente' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('RECEBIDO');
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos/10', headers: { 'x-user-id': 'c-2', 'x-user-role': 'cliente' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos/10', headers: operador })).statusCode).toBe(200);
  });

  it('pedido sem visão ainda: 404; sem login: 401; entregador: 403', async () => {
    const f = nova(armazem);
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos/99', headers: operador })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos/99' })).statusCode).toBe(401);
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos/99', headers: { 'x-user-id': 'e', 'x-user-role': 'entregador' } })).statusCode).toBe(403);
  });

  it('a lista (só operador) vem do mais novo para o mais antigo', async () => {
    const f = nova(armazem);
    for (const id of [1, 3, 2]) await armazem.registrar(reservar(id));
    const r = await f.inject({ method: 'GET', url: '/api/consultas/pedidos', headers: operador });
    expect(r.json().map((p: { id: number }) => p.id)).toEqual([3, 2, 1]);
    expect((await f.inject({ method: 'GET', url: '/api/consultas/pedidos', headers: { 'x-user-id': 'c', 'x-user-role': 'cliente' } })).statusCode).toBe(403);
  });
});
