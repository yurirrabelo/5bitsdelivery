import { criarApp, criarLogger, env, envInt, lerSegredo } from '@delivery/commons';
import { ConfigAuth, criarUsuario, registrarRotasAuth } from './app';

async function main() {
  const log = criarLogger('auth');
  // A chave do JWT vem do Secrets Manager; os usuários, do .env (o hash bcrypt é gerado na subida)
  const { segredo } = await lerSegredo<{ segredo: string }>(env('SEGREDO_JWT'), log);

  const cfg: ConfigAuth = {
    segredoJwt: segredo,
    expiracaoHoras: envInt('JWT_EXPIRACAO_HORAS', 12),
    eventoCodigo: env('EVENTO_CODIGO'),
    usuarios: [
      criarUsuario(env('OPERADOR_USUARIO'), 'Gestão', 'operador', null, env('OPERADOR_SENHA')), // o papel interno é "operador"; na tela aparece "Gestão"
      criarUsuario(env('ENTREGADOR1_USUARIO'), env('ENTREGADOR1_NOME'), 'entregador', 1, env('ENTREGADOR1_SENHA')),
      criarUsuario(env('ENTREGADOR2_USUARIO'), env('ENTREGADOR2_NOME'), 'entregador', 2, env('ENTREGADOR2_SENHA')),
    ],
  };

  const app = criarApp(log);
  registrarRotasAuth(app, cfg);
  await app.listen({ host: '0.0.0.0', port: 3000 });
  log.info('auth no ar');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
