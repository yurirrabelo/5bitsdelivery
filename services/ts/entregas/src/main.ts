import { criarApp, env, envInt, iniciarConsumidor, iniciarInfra, registrarSaude } from '@delivery/commons';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { registrarRotasEntregas } from './app';
import { Deps, aoConfirmarPedido } from './ofertas';
import { Hub } from './hub';
import { Posicoes, iniciarProcessador } from './redis';
import { criarS3, exportarPendentes } from './rota';

// Roda fn a cada intervaloMs (depois de terminar a anterior). Erros só são logados.
function periodico(nome: string, intervaloMs: number, fn: () => Promise<unknown>, log: { warn: (o: object, m: string) => void }) {
  const ciclo = () =>
    fn()
      .catch((e) => log.warn({ err: (e as Error).message, laco: nome }, 'laço com falha; tento de novo'))
      .finally(() => setTimeout(ciclo, intervaloMs));
  setTimeout(ciclo, intervaloMs);
}

async function main() {
  const { log, pool, broker, estado, validador } = await iniciarInfra('entregas', join(__dirname, '..', 'sql'));

  // Entregadores a partir do .env (upsert; o status de quem já existe não é mexido)
  for (const n of [1, 2]) {
    await pool.query('INSERT INTO entregadores (id, nome) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome', [
      n,
      env(`ENTREGADOR${n}_NOME`),
    ]);
  }

  const redisUrl = env('REDIS_URL');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 }); // reconecta sozinho
  const redisBloqueante = new Redis(redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (e) => log.warn({ err: e.message }, 'redis'));
  redisBloqueante.on('error', () => undefined);
  const posicoes = new Posicoes(redis);
  const hub = new Hub();
  const deps: Deps = { pool, hub, log };

  iniciarConsumidor({
    broker, pool, fila: env('FILA_ENTREGAS'), validador, log, estado,
    manipuladores: { 'pedido.confirmado': aoConfirmarPedido(deps) },
  });

  const s3 = criarS3(env('AWS_ENDPOINT_URL'), env('AWS_REGION'));
  periodico('rotas', 10000, () => exportarPendentes(pool, s3, env('S3_BUCKET_ROTAS'), log), log);

  let encerrando = false;
  void iniciarProcessador(
    { redis: redisBloqueante, posicoes, pool, hub, deps, geofenceM: envInt('GEOFENCE_RAIO_M', 50), consumidor: hostname(), log },
    () => encerrando,
  );

  const app = criarApp(log);
  registrarSaude(app, { pool, broker, estado, extras: { redis: async () => (await redis.ping()) === 'PONG' } });
  await registrarRotasEntregas(app, { pool, hub, posicoes, deps, log });
  await app.listen({ host: '0.0.0.0', port: 3000 });
  log.info('entregas no ar');
  process.once('SIGTERM', () => {
    encerrando = true;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
