import { criarApp, env, envInt, iniciarConsumidor, iniciarInfra, registrarSaude } from '@delivery/commons';
import { join } from 'node:path';
import { GatewayHttp } from './gateway';
import { cobrar, estornar } from './regras';

async function main() {
  const { log, pool, broker, estado, validador } = await iniciarInfra('pagamento', join(__dirname, '..', 'sql'));
  // quanto o pagamento espera o gateway: bem acima do prazo, quem decide que demorou é o pedidos
  const gateway = new GatewayHttp(env('GATEWAY_URL'), envInt('GATEWAY_TIMEOUT_MS', 60000));
  const dep = { gateway };

  iniciarConsumidor({
    broker,
    pool,
    fila: env('FILA_PAGAMENTO'),
    validador,
    log,
    estado,
    manipuladores: { 'pagamento.cobrar': cobrar(dep), 'pagamento.estornar': estornar(dep) },
  });

  const app = criarApp(log);
  registrarSaude(app, { pool, broker, estado });
  await app.listen({ host: '0.0.0.0', port: 3000 });
  log.info('pagamento no ar');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
