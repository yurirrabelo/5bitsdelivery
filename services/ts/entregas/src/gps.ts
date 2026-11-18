// Posição enviada pelo navegador do entregador (Geolocation API do celular):
//   POST /api/entregas/posicoes  { lat, lon, precisao (metros), velocidade (m/s) }
// O horário é o do servidor: o relógio do celular pode estar errado e não precisamos dele.

export interface PosicaoGps {
  lat: number;
  lon: number;
  velocidadeKmh: number | null;
  precisao: number | null; // metros
}

export class ErroGps extends Error {}

const MS_PARA_KMH = 3.6;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function lerPosicao(corpo: unknown): PosicaoGps {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const lat = num(c.lat);
  const lon = num(c.lon);
  if (lat === null || lon === null) throw new ErroGps('lat e lon obrigatórios');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new ErroGps('coordenadas fora do intervalo');
  const velocidade = num(c.velocidade);
  return {
    lat,
    lon,
    velocidadeKmh: velocidade === null ? null : velocidade * MS_PARA_KMH,
    precisao: num(c.precisao),
  };
}
