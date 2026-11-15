import { describe, expect, it } from 'vitest';
import { distanciaM, dentroDoRaio } from '../src/geo';
import { ErroGps, parseGps, parseTimestamp, parseUrlencoded } from '../src/gps';

const AGORA = 1_800_000_000_000; // ms, fixo para os testes

describe('parser do /gps: os três formatos do Traccar', () => {
  it('formato 1: query string (speed em NÓS vira km/h)', () => {
    const p = parseGps(
      { id: 'ent1-abc', lat: '-26.9194', lon: '-49.0661', timestamp: '1700000000', speed: '10', bearing: '90', accuracy: '5.5', altitude: '12', batt: '80' },
      undefined, AGORA);
    expect(p.deviceId).toBe('ent1-abc');
    expect(p.lat).toBe(-26.9194);
    expect(p.lon).toBe(-49.0661);
    expect(p.ts).toBe(1_700_000_000_000);
    expect(p.velocidadeKmh).toBeCloseTo(18.52, 5); // 10 nós x 1,852
    expect(p.precisao).toBe(5.5);
  });

  it('formato 2: corpo urlencoded com os mesmos campos', () => {
    const corpo = parseUrlencoded('id=ent1-abc&lat=-26.9&lon=-49.0&timestamp=1700000000000&speed=5');
    const p = parseGps({}, corpo, AGORA);
    expect(p).toMatchObject({ deviceId: 'ent1-abc', lat: -26.9, lon: -49.0, ts: 1_700_000_000_000 });
    expect(p.velocidadeKmh).toBeCloseTo(9.26, 5);
  });

  it('formato 3: corpo JSON com location.coords (speed em m/s vira km/h)', () => {
    const p = parseGps({}, {
      device_id: 'ent1-abc',
      location: {
        timestamp: '2026-11-26T19:03:12.000Z',
        coords: { latitude: -26.91, longitude: -49.07, speed: 10, heading: 180, accuracy: 3, altitude: 5 },
        battery: { level: 0.5 },
      },
    }, AGORA);
    expect(p.deviceId).toBe('ent1-abc');
    expect(p.lat).toBe(-26.91);
    expect(p.ts).toBe(Date.parse('2026-11-26T19:03:12.000Z'));
    expect(p.velocidadeKmh).toBeCloseTo(36, 5); // 10 m/s x 3,6
    expect(p.precisao).toBe(3);
  });

  it('a query tem prioridade sobre o corpo e o id também vale como identificador no JSON', () => {
    const p = parseGps({ id: 'da-query' }, { device_id: 'do-corpo', lat: 1, lon: 2 }, AGORA);
    expect(p.deviceId).toBe('da-query');
  });

  it('sem dispositivo, sem coordenadas ou fora do intervalo: erro', () => {
    expect(() => parseGps({ lat: '1', lon: '2' }, undefined, AGORA)).toThrow(ErroGps);
    expect(() => parseGps({ id: 'x' }, undefined, AGORA)).toThrow(ErroGps);
    expect(() => parseGps({ id: 'x', lat: '91', lon: '0' }, undefined, AGORA)).toThrow(ErroGps);
    expect(() => parseGps({ id: 'x', lat: '0', lon: '181' }, undefined, AGORA)).toThrow(ErroGps);
    expect(() => parseGps({ id: 'x', lat: 'abc', lon: '0' }, undefined, AGORA)).toThrow(ErroGps);
  });

  it('sem velocidade a velocidade é null', () => {
    expect(parseGps({ id: 'x', lat: '1', lon: '2' }, undefined, AGORA).velocidadeKmh).toBeNull();
  });
});

describe('timestamp: segundos, milissegundos, ISO ou ausente', () => {
  it('segundos', () => expect(parseTimestamp('1700000000', AGORA)).toBe(1_700_000_000_000));
  it('milissegundos', () => expect(parseTimestamp(1_700_000_000_123, AGORA)).toBe(1_700_000_000_123));
  it('ISO-8601', () => expect(parseTimestamp('2026-11-26T19:03:12Z', AGORA)).toBe(Date.parse('2026-11-26T19:03:12Z')));
  it('ausente ou inválido: hora do servidor', () => {
    expect(parseTimestamp(undefined, AGORA)).toBe(AGORA);
    expect(parseTimestamp('lixo', AGORA)).toBe(AGORA);
    expect(parseTimestamp('42', AGORA)).toBe(AGORA);
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
