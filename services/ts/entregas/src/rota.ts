import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger, Pool } from './comuns';

export interface RotaGeoJson {
  type: 'Feature';
  properties: { pedidoId: number; pontos: number };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

// Trajeto da entrega: LineString [lon, lat] com as posições gravadas, em ordem de tempo
export async function montarRota(pool: Pool, pedidoId: number): Promise<RotaGeoJson> {
  const r = await pool.query('SELECT lat, lon FROM posicoes WHERE pedido_id = $1 ORDER BY ts, id', [pedidoId]);
  const coordinates = r.rows.map((p) => [p.lon, p.lat] as [number, number]);
  return { type: 'Feature', properties: { pedidoId, pontos: coordinates.length }, geometry: { type: 'LineString', coordinates } };
}

export function criarS3(endpoint: string, region: string): S3Client {
  return new S3Client({ endpoint, region, forcePathStyle: true });
}

// Exporta para o S3 a rota das entregas concluídas (rotas/pedido-<id>.geojson). Se o MiniStack estiver fora,
// a exportação fica pendente (rota_exportada = false) e o laço tenta de novo.
export async function exportarPendentes(pool: Pool, s3: S3Client, bucket: string, log: Logger): Promise<number> {
  const pendentes = await pool.query("SELECT pedido_id FROM entregas WHERE status = 'CONCLUIDA' AND NOT rota_exportada ORDER BY concluida_em LIMIT 20");
  let feitas = 0;
  for (const p of pendentes.rows) {
    const pedidoId = Number(p.pedido_id);
    try {
      const rota = await montarRota(pool, pedidoId);
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: `rotas/pedido-${pedidoId}.geojson`, Body: JSON.stringify(rota), ContentType: 'application/geo+json' }),
      );
      await pool.query('UPDATE entregas SET rota_exportada = true WHERE pedido_id = $1', [pedidoId]);
      log.info({ pedidoId, pontos: rota.properties.pontos }, 'rota exportada para o S3');
      feitas++;
    } catch (e) {
      log.warn({ pedidoId, err: (e as Error).message }, 'exportação da rota pendente (S3 indisponível?); tento de novo');
      break; // se o S3 está fora, as demais também falhariam
    }
  }
  return feitas;
}
