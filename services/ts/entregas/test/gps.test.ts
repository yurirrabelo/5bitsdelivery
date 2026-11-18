import { describe, expect, it } from 'vitest';
import { distanciaM, dentroDoRaio } from '../src/geo';
import { ErroGps, lerPosicao } from '../src/gps';

describe('posição enviada pelo navegador do entregador', () => {
  it('lê latitude, longitude e precisão; a velocidade chega em m/s e vira km/h', () => {
    const p = lerPosicao({ lat: -26.9194, lon: -49.0661, precisao: 5.5, velocidade: 10 });
    expect(p.lat).toBe(-26.9194);
    expect(p.lon).toBe(-49.0661);
    expect(p.precisao).toBe(5.5);
    expect(p.velocidadeKmh).toBeCloseTo(36, 5); // 10 m/s x 3,6
  });

  it('sem velocidade ou precisão (o navegador devolve null parado): ficam null', () => {
    const p = lerPosicao({ lat: 1, lon: 2, velocidade: null, precisao: null });
    expect(p.velocidadeKmh).toBeNull();
    expect(p.precisao).toBeNull();
  });

  it('aceita números escritos como texto', () => {
    expect(lerPosicao({ lat: '-26.9', lon: '-49.0' })).toMatchObject({ lat: -26.9, lon: -49 });
  });

  it('sem coordenadas, fora do intervalo ou corpo vazio: erro', () => {
    expect(() => lerPosicao({ lat: 1 })).toThrow(ErroGps);
    expect(() => lerPosicao({ lat: 91, lon: 0 })).toThrow(ErroGps);
    expect(() => lerPosicao({ lat: 0, lon: 181 })).toThrow(ErroGps);
    expect(() => lerPosicao({ lat: 'abc', lon: 0 })).toThrow(ErroGps);
    expect(() => lerPosicao(undefined)).toThrow(ErroGps);
  });
});

describe('distância e geofence', () => {
  it('1 grau de latitude são cerca de 111 km', () => {
    expect(distanciaM(0, 0, 1, 0)).toBeGreaterThan(111000);
    expect(distanciaM(0, 0, 1, 0)).toBeLessThan(111400);
  });

  it('mesmo ponto: zero', () => expect(distanciaM(-26.9, -49.0, -26.9, -49.0)).toBe(0));

  it('geofence de 50 m: 30 m dentro, 80 m fora', () => {
    const lat = -26.9194;
    const lon = -49.0661;
    const metroEmGrau = 1 / 111195;
    expect(dentroDoRaio(lat + 30 * metroEmGrau, lon, lat, lon, 50)).toBe(true);
    expect(dentroDoRaio(lat + 80 * metroEmGrau, lon, lat, lon, 50)).toBe(false);
  });
});
