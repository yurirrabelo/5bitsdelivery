// Geometria da rota simulada: percorre uma linha em passos de distância fixa (velocidade x intervalo).
export type Ponto = [number, number]; // [lon, lat], como no GeoJSON

function distanciaM(a: Ponto, b: Ponto): number {
  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Aceita Feature, FeatureCollection ou geometria LineString
export function extrairLinha(geojson: any): Ponto[] {
  const g = geojson?.type === 'FeatureCollection' ? geojson.features?.[0]?.geometry : geojson?.type === 'Feature' ? geojson.geometry : geojson;
  if (g?.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length === 0) {
    throw new Error('o GeoJSON precisa ter uma geometria LineString com pelo menos um ponto');
  }
  return g.coordinates.map((c: number[]) => [c[0], c[1]] as Ponto);
}

// Pontos ao longo da linha, um a cada `passoM` metros, terminando exatamente no último ponto
export function percorrer(linha: Ponto[], passoM: number): Ponto[] {
  const saida: Ponto[] = [linha[0]];
  let falta = passoM; // quanto falta andar até o próximo ponto emitido
  for (let i = 1; i < linha.length; i++) {
    let a = linha[i - 1];
    const b = linha[i];
    let seg = distanciaM(a, b);
    while (seg >= falta && seg > 0) {
      const t = falta / seg;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      saida.push(a);
      seg = distanciaM(a, b);
      falta = passoM;
    }
    falta -= seg;
  }
  const ultimo = linha[linha.length - 1];
  const fim = saida[saida.length - 1];
  if (fim[0] !== ultimo[0] || fim[1] !== ultimo[1]) saida.push(ultimo);
  return saida;
}

// Reta entre dois pontos (para o smoke, que não tem arquivo de rota)
export function reta(de: Ponto, para: Ponto): Ponto[] {
  return [de, para];
}

// km/h e intervalo -> metros por passo
export const passoM = (kmh: number, intervaloS: number) => (kmh / 3.6) * intervaloS;
