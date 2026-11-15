import { criarApp, criarLogger, envInt } from '@delivery/commons';
import { registrarRotasGateway } from './app';

async function main() {
  const log = criarLogger('gateway-pagamento');
  const app = criarApp(log);
  // lidos a cada chamada: o valor vem do ambiente do container (recriar o container muda o comportamento)
  registrarRotasGateway(app, {
    latenciaMs: () => envInt('GATEWAY_LATENCIA_MS', 0),
    taxaFalha: () => envInt('GATEWAY_TAXA_FALHA', 0),
  });
  await app.listen({ host: '0.0.0.0', port: 3000 });
  log.info({ latenciaMs: envInt('GATEWAY_LATENCIA_MS', 0), taxaFalha: envInt('GATEWAY_TAXA_FALHA', 0) }, 'gateway-pagamento no ar');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
