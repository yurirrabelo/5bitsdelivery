import { Envelope, ErroInfraestrutura, criarEnvelope, criarPool, erroDeInfra, migrar, transacao } from '@delivery/commons';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Gateway, ResultadoCobranca } from '../src/gateway';
import { cobrar, estornar } from '../src/regras';

const log = pino({ level: 'silent' });
const PG = new URL(process.env.TEST_PG_URL ?? 'postgres://teste:teste@localhost:5432/teste');

// Gateway falso: conta as chamadas e devolve o que o teste mandar
class GatewayFalso implements Gateway {
  cobrancas = 0;
  estornos = 0;
  resultado: ResultadoCobranca = { status: 'APROVADO', referencia: 'ref-teste' };
  estornoFalha = false;
  async cobrar() {
    this.cobrancas++;
    return this.resultado;
  }
  async estornar() {
    this.estornos++;
    if (this.estornoFalha) throw new ErroInfraestrutura('gateway fora');
  }
}

let pool: Pool;
let gw: GatewayFalso;
const correlacao = () => randomUUID();
const expira = (segundos = 15) => new Date(Date.now() + segundos * 1000).toISOString();
const cmdCobrar = (pedidoId: number, expiraEm = expira()) => criarEnvelope('pagamento.cobrar', correlacao(), { pedidoId, expiraEm });
const cmdEstornar = (pedidoId: number) => criarEnvelope('pagamento.estornar', correlacao(), { pedidoId });

// roda o manipulador como o consumidor faz: dentro de uma transação
const rodar = (m: ReturnType<typeof cobrar>, e: Envelope) => transacao(pool, (c) => m(c, e, log));
const saidas = async () => (await pool.query('SELECT type, payload FROM outbox ORDER BY id')).rows.map((r) => ({ type: r.type, payload: r.payload.payload }));
const pagamento = async (id: number) => (await pool.query('SELECT status, referencia, motivo FROM pagamentos WHERE pedido_id = $1', [id])).rows[0];

beforeAll(async () => {
  pool = criarPool({ host: PG.hostname, port: Number(PG.port || 5432), dbname: PG.pathname.slice(1), username: PG.username, password: PG.password });
  await migrar(pool, join(__dirname, '..', 'sql'));
});
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query('TRUNCATE pagamentos, outbox, mensagens_processadas');
  gw = new GatewayFalso();
});

describe('cobrar', () => {
  it('aprovado: grava o pagamento e responde pagamento.aprovado com a referência', async () => {
    await rodar(cobrar({ gateway: gw }), cmdCobrar(1));
    expect(gw.cobrancas).toBe(1);
    expect(await pagamento(1)).toMatchObject({ status: 'APROVADO', referencia: 'ref-teste' });
    expect(await saidas()).toEqual([{ type: 'pagamento.aprovado', payload: { pedidoId: 1, referencia: 'ref-teste' } }]);
  });

  it('gateway falhou: pagamento.recusado com GATEWAY_FALHOU', async () => {
    gw.resultado = { status: 'FALHA', erro: 'gateway respondeu 503' };
    await rodar(cobrar({ gateway: gw }), cmdCobrar(2));
    expect(await pagamento(2)).toMatchObject({ status: 'RECUSADO', motivo: 'GATEWAY_FALHOU' });
    expect(await saidas()).toEqual([{ type: 'pagamento.recusado', payload: { pedidoId: 2, motivo: 'GATEWAY_FALHOU' } }]);
  });

  it('cobrança já vencida: recusa com PRAZO_EXPIRADO sem chamar o gateway', async () => {
    await rodar(cobrar({ gateway: gw }), cmdCobrar(3, expira(-5)));
    expect(gw.cobrancas).toBe(0);
    expect(await saidas()).toEqual([{ type: 'pagamento.recusado', payload: { pedidoId: 3, motivo: 'PRAZO_EXPIRADO' } }]);
  });

  it('comando repetido (outro messageId): não cobra de novo, repete a mesma resposta', async () => {
    await rodar(cobrar({ gateway: gw }), cmdCobrar(4));
    await rodar(cobrar({ gateway: gw }), cmdCobrar(4));
    expect(gw.cobrancas).toBe(1);
    const s = await saidas();
    expect(s).toHaveLength(2);
    expect(s[1]).toEqual(s[0]);
  });

  it('a resposta herda o correlationId do comando', async () => {
    const cmd = cmdCobrar(5);
    await rodar(cobrar({ gateway: gw }), cmd);
    const r = await pool.query('SELECT payload FROM outbox');
    expect(r.rows[0].payload.correlationId).toBe(cmd.correlationId);
  });

  it('se o manipulador falha depois de chamar o gateway, nada é gravado (a nova entrega refaz com a mesma chave)', async () => {
    const quebrado = { cobrar: async () => ({ status: 'APROVADO', referencia: 'r' }) as ResultadoCobranca, estornar: async () => undefined };
    const falha = async () => {
      await transacao(pool, async (c) => {
        await cobrar({ gateway: quebrado })(c, cmdCobrar(6), log);
        throw new Error('réplica morreu antes do commit');
      });
    };
    await expect(falha()).rejects.toThrow();
    expect(await pagamento(6)).toBeUndefined();
    expect(await saidas()).toEqual([]);
  });
});

describe('estornar', () => {
  beforeEach(async () => {
    await rodar(cobrar({ gateway: gw }), cmdCobrar(10));
    await pool.query('TRUNCATE outbox');
  });

  it('estorna a cobrança aprovada, uma vez no gateway, e responde pagamento.estornado', async () => {
    await rodar(estornar({ gateway: gw }), cmdEstornar(10));
    expect(gw.estornos).toBe(1);
    expect((await pagamento(10)).status).toBe('ESTORNADO');
    expect(await saidas()).toEqual([{ type: 'pagamento.estornado', payload: { pedidoId: 10 } }]);
  });

  it('estorno repetido: não estorna de novo no gateway, mas repete a resposta', async () => {
    await rodar(estornar({ gateway: gw }), cmdEstornar(10));
    await rodar(estornar({ gateway: gw }), cmdEstornar(10));
    expect(gw.estornos).toBe(1);
    expect((await saidas()).map((s) => s.type)).toEqual(['pagamento.estornado', 'pagamento.estornado']);
  });

  it('gateway fora: lança erro de infraestrutura (a mensagem fica retida) e o UPDATE é desfeito', async () => {
    gw.estornoFalha = true;
    const erro = await rodar(estornar({ gateway: gw }), cmdEstornar(10)).catch((e) => e);
    expect(erroDeInfra(erro)).toBe(true);
    expect((await pagamento(10)).status).toBe('APROVADO');
    expect(await saidas()).toEqual([]);
  });

  it('sem cobrança aprovada não há o que estornar', async () => {
    await rodar(estornar({ gateway: gw }), cmdEstornar(999));
    expect(gw.estornos).toBe(0);
    expect(await saidas()).toEqual([]);
  });
});
