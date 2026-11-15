import { describe, expect, it } from 'vitest';
import { Ponto, extrairLinha, passoM, percorrer, reta } from '../src/rota';

const distM = (a: Ponto, b: Ponto) => {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

describe('simulador: percurso da rota', () => {
  it('passo em metros a partir de km/h e intervalo', () => {
    expect(passoM(36, 1)).toBeCloseTo(10, 5); // 36 km/h = 10 m/s
    expect(passoM(30, 3)).toBeCloseTo(25, 5); // moto a 30 km/h, 3 s entre pontos
  });

  it('percorre a reta em passos regulares e termina no destino', () => {
    const a: Ponto = [-49.0661, -26.9194];
    const b: Ponto = [-49.0621, -26.9154];
    const pontos = percorrer(reta(a, b), 100);
    expect(pontos[0]).toEqual(a);
    expect(pontos[pontos.length - 1]).toEqual(b);
    for (let i = 1; i < pontos.length - 1; i++) expect(distM(pontos[i - 1], pontos[i])).toBeGreaterThan(95);
    for (let i = 1; i < pontos.length; i++) expect(distM(pontos[i - 1], pontos[i])).toBeLessThan(105);
  });

  it('segue uma rota com curvas sem pular o vértice', () => {
    const linha: Ponto[] = [[0, 0], [0.001, 0], [0.001, 0.001]];
    const pontos = percorrer(linha, 30);
    expect(pontos[pontos.length - 1]).toEqual([0.001, 0.001]);
    expect(pontos.length).toBeGreaterThan(8);
  });

  it('rota curta demais para um passo: só origem e destino', () => {
    expect(percorrer([[0, 0], [0.0001, 0]], 500)).toHaveLength(2);
  });

  it('extrai a linha de Feature, FeatureCollection e LineString', () => {
    const g = { type: 'LineString', coordinates: [[1, 2], [3, 4]] };
    expect(extrairLinha(g)).toEqual([[1, 2], [3, 4]]);
    expect(extrairLinha({ type: 'Feature', geometry: g })).toEqual([[1, 2], [3, 4]]);
    expect(extrairLinha({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g }] })).toEqual([[1, 2], [3, 4]]);
  });

  it('GeoJSON sem LineString: erro claro', () => {
    expect(() => extrairLinha({ type: 'Point', coordinates: [1, 2] })).toThrow(/LineString/);
  });
});
