import { Broker, ValidadorContratos, criarApp, criarLogger, env, iniciarConsumidor, lerSegredo, EstadoSaude } from '@delivery/commons';
import { ArmazemDynamo } from './armazem';
import { registrarRotasConsultas } from './app';

// CQRS: este serviço não tem banco relacional. A fila consultas.entrada recebe TODAS as mensagens do fluxo
// e a visão de cada pedido fica no DynamoDB (criado pelo Terraform no MiniStack).
async function main() {
  const log = criarLogger('consultas');
  const { url } = await lerSegredo<{ url: string }>(env('SEGREDO_RABBITMQ'), log);
  const broker = new Broker(url, log);
  const estado = new EstadoSaude();
  const armazem = new ArmazemDynamo(env('AWS_ENDPOINT_URL'), env('AWS_REGION'), env('DYNAMODB_TABELA_VISAO'));

  iniciarConsumidor({
    broker,
    fila: env('FILA_CONSULTAS'),
    validador: new ValidadorContratos(),
    log,
    estado,
    executar: (envelope) => armazem.registrar(envelope), // inbox + visão na mesma transação do DynamoDB
  });

  const app = criarApp(log);
  registrarRotasConsultas(app, armazem, async () => broker.conectado() && !estado.segurando);
  await app.listen({ host: '0.0.0.0', port: 3000 });
  log.info('consultas no ar');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
