import { describe, expect, it } from 'vitest';
import { ConfigAutoescala, decidir, replicasDesejadas } from '../src/decisao';

const cfg: ConfigAutoescala = { min: 2, max: 6, mensagensPorReplica: 10, esperaSeg: 15 };
const T0 = 1_000_000;

describe('réplicas desejadas', () => {
  it('uma réplica a cada N mensagens, entre o mínimo e o máximo', () => {
    expect(replicasDesejadas(0, cfg)).toBe(2); // nunca abaixo do mínimo
    expect(replicasDesejadas(20, cfg)).toBe(2);
    expect(replicasDesejadas(21, cfg)).toBe(3);
    expect(replicasDesejadas(45, cfg)).toBe(5);
    expect(replicasDesejadas(500, cfg)).toBe(6); // nunca acima do máximo
  });
});

describe('decisão', () => {
  it('mantém quando o número de réplicas já é o que a fila pede', () => {
    expect(decidir(15, 2, 0, T0, cfg)).toMatchObject({ acao: 'manter', alvo: 2 });
  });

  it('sobe de uma vez até o que a fila pede', () => {
    expect(decidir(45, 2, 0, T0, cfg)).toMatchObject({ acao: 'subir', alvo: 5 });
  });

  it('não passa do máximo', () => {
    expect(decidir(1000, 2, 0, T0, cfg)).toMatchObject({ acao: 'subir', alvo: 6 });
  });

  it('desce uma réplica por vez, e nunca abaixo do mínimo', () => {
    expect(decidir(0, 6, 0, T0, cfg)).toMatchObject({ acao: 'descer', alvo: 5 });
    expect(decidir(0, 3, 0, T0, cfg)).toMatchObject({ acao: 'descer', alvo: 2 });
    expect(decidir(0, 2, 0, T0, cfg)).toMatchObject({ acao: 'manter', alvo: 2 });
  });

  it('respeita a espera mínima entre mudanças (sem flapping)', () => {
    const mudouHa = (s: number) => T0 - s * 1000;
    expect(decidir(45, 2, mudouHa(5), T0, cfg)).toMatchObject({ acao: 'manter' }); // mudou há 5 s: espera
    expect(decidir(45, 2, mudouHa(5), T0, cfg).motivo).toContain('em espera');
    expect(decidir(45, 2, mudouHa(16), T0, cfg)).toMatchObject({ acao: 'subir', alvo: 5 }); // passou da espera
    expect(decidir(0, 5, mudouHa(3), T0, cfg)).toMatchObject({ acao: 'manter' });
  });

  it('a primeira decisão (sem mudança anterior) não espera', () => {
    expect(decidir(45, 2, 0, T0, cfg)).toMatchObject({ acao: 'subir' });
  });
});
