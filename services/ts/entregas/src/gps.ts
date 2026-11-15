// Parser do /gps. O formato do Traccar Client mudou entre versões, então aceitamos os três:
//  1. query string (GET ou POST): id, lat, lon, timestamp, speed (NÓS), bearing, accuracy, altitude, batt
//  2. corpo application/x-www-form-urlencoded com os mesmos campos
//  3. corpo JSON: {"device_id", "location": {"timestamp", "coords": {"latitude", "longitude", "speed" (m/s),
//     "heading", "accuracy", "altitude"}, "battery": {"level"}}}

export interface PosicaoGps {
  deviceId: string;
  lat: number;
  lon: number;
  ts: number; // milissegundos desde 1970
  velocidadeKmh: number | null;
  precisao: number | null;
}

export class ErroGps extends Error {}

const NOS_PARA_KMH = 1.852;
const MS_PARA_KMH = 3.6;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// O timestamp pode vir em segundos, milissegundos ou ISO-8601. Sem ele (ou inválido), vale a hora do servidor.
export function parseTimestamp(v: unknown, agora: number = Date.now()): number {
  const n = num(v);
  if (n !== null) {
    if (n > 1e12) return Math.round(n); // milissegundos
    if (n > 1e9) return Math.round(n * 1000); // segundos
    return agora;
  }
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return agora;
}

type Dados = Record<string, unknown>;
const objeto = (v: unknown): Dados | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dados) : null);

export function parseGps(query: unknown, corpo: unknown, agora: number = Date.now()): PosicaoGps {
  const q = objeto(query) ?? {};
  const c = objeto(corpo);

  // formato 3: JSON com "location"
  const loc = objeto(c?.location);
  if (c && loc) {
    const coords = objeto(loc.coords) ?? {};
    const deviceId = String(c.device_id ?? q.id ?? '');
    return montar(deviceId, num(coords.latitude), num(coords.longitude), loc.timestamp, nullMul(num(coords.speed), MS_PARA_KMH), num(coords.accuracy), agora);
  }

  // formatos 1 e 2: campos planos, na query ou no corpo (a query tem prioridade)
  const d: Dados = { ...(c ?? {}), ...q };
  const deviceId = String(d.id ?? d.device_id ?? '');
  return montar(deviceId, num(d.lat), num(d.lon), d.timestamp, nullMul(num(d.speed), NOS_PARA_KMH), num(d.accuracy), agora);
}

const nullMul = (v: number | null, f: number) => (v === null ? null : v * f);

function montar(deviceId: string, lat: number | null, lon: number | null, timestamp: unknown, velocidadeKmh: number | null, precisao: number | null, agora: number): PosicaoGps {
  if (!deviceId) throw new ErroGps('identificador do dispositivo ausente');
  if (lat === null || lon === null) throw new ErroGps('lat e lon obrigatórios');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new ErroGps('coordenadas fora do intervalo');
  return { deviceId, lat, lon, ts: parseTimestamp(timestamp, agora), velocidadeKmh, precisao };
}

// Corpo urlencoded -> objeto (para o parser de conteúdo do Fastify)
export function parseUrlencoded(texto: string): Dados {
  return Object.fromEntries(new URLSearchParams(texto));
}
