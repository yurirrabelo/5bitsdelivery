// Distância entre dois pontos em metros (fórmula de haversine)
export function distanciaM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Dentro do raio do destino? (geofence)
export function dentroDoRaio(lat: number, lon: number, destLat: number, destLon: number, raioM: number): boolean {
  return distanciaM(lat, lon, destLat, destLon) <= raioM;
}
