import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MensagemInvalida, ValidadorContratos } from '../src/contratos';
import { criarEnvelope } from '../src/envelope';

const validador = new ValidadorContratos();
const correlacao = randomUUID();

describe('validação de contratos', () => {
  it('aceita mensagens válidas de cada tipo', () => {
    const casos: [string, object][] = [
      ['estoque.reservar', { pedidoId: 1 }],
      ['pagamento.cobrar', { pedidoId: 1, expiraEm: new Date().toISOString() }],
      ['pagamento.aprovado', { pedidoId: 1, referencia: 'ref-1' }],
      ['pagamento.recusado', { pedidoId: 1, motivo: 'GATEWAY_FALHOU' }],
      ['pedido.cancelado', { pedidoId: 1, motivo: 'PRAZO_EXPIRADO' }],
      ['entrega.atribuida', { pedidoId: 1, entregadorId: 2, entregadorNome: 'Zé' }],
      ['entrega.concluida', { pedidoId: 1, entregadorId: 2, modo: 'geofence' }],
    ];
    for (const [tipo, payload] of casos) {
      expect(() => validador.validar(criarEnvelope(tipo, correlacao, payload))).not.toThrow();
    }
  });

  it('aceita pedido.confirmado sem destino (pedido do QR)', () => {
    const e = criarEnvelope('pedido.confirmado', correlacao, {
      pedidoId: 7,
      origem: { lat: -26.9, lon: -49.0 },
      destino: null,
      entregadorPreferidoId: null,
    });
    expect(() => validador.validar(e)).not.toThrow();
  });

  it('pedido.confirmado v1 e v2 convivem; o formato de uma não vale para a outra', () => {
    const origem = { lat: -26.9, lon: -49.0 };
    const destino = { lat: -26.91, lon: -49.07 };
    const v1 = { pedidoId: 7, origem, destino, entregadorPreferidoId: 2 };
    const v2 = { pedidoId: 7, origem, entrega: { destino, entregadorPreferidoId: 2 } };
    expect(() => validador.validar(criarEnvelope('pedido.confirmado', correlacao, v1, 1))).not.toThrow();
    expect(() => validador.validar(criarEnvelope('pedido.confirmado', correlacao, v2, 2))).not.toThrow();
    expect(() => validador.validar(criarEnvelope('pedido.confirmado', correlacao, v2, 1))).toThrow(MensagemInvalida);
    expect(() => validador.validar(criarEnvelope('pedido.confirmado', correlacao, v1, 2))).toThrow(MensagemInvalida);
  });

  it('tolera campos a mais no payload (leitor tolerante)', () => {
    const e = criarEnvelope('estoque.reservar', correlacao, { pedidoId: 1, campoNovo: 'x' });
    expect(() => validador.validar(e)).not.toThrow();
  });

  it('rejeita payload sem campo obrigatório', () => {
    const e = criarEnvelope('estoque.reservar', correlacao, { outro: 1 });
    expect(() => validador.validar(e)).toThrow(MensagemInvalida);
  });

  it('rejeita payload com tipo errado', () => {
    const e = criarEnvelope('estoque.reservar', correlacao, { pedidoId: 'abc' });
    expect(() => validador.validar(e)).toThrow(MensagemInvalida);
  });

  it('rejeita envelope sem messageId ou com id que não é uuid', () => {
    const e: any = criarEnvelope('estoque.reservar', correlacao, { pedidoId: 1 });
    expect(() => validador.validar({ ...e, messageId: 'nao-e-uuid' })).toThrow(MensagemInvalida);
    delete e.messageId;
    expect(() => validador.validar(e)).toThrow(MensagemInvalida);
  });

  it('rejeita tipo ou versão desconhecidos', () => {
    expect(() => validador.validar(criarEnvelope('coisa.inventada', correlacao, {}))).toThrow(MensagemInvalida);
    expect(() => validador.validar(criarEnvelope('estoque.reservar', correlacao, { pedidoId: 1 }, 9))).toThrow(
      MensagemInvalida,
    );
  });

  it('rejeita valor fora do enum', () => {
    const e = criarEnvelope('entrega.concluida', correlacao, { pedidoId: 1, entregadorId: 1, modo: 'telepatia' });
    expect(() => validador.validar(e)).toThrow(MensagemInvalida);
  });
});
