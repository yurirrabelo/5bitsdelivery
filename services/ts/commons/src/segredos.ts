import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { dormir, env } from './config';
import { Logger } from './logger';

// Lê um segredo (JSON) do Secrets Manager. Tenta de novo até o MiniStack responder.
export async function lerSegredo<T = Record<string, any>>(nome: string, log?: Logger): Promise<T> {
  const cliente = new SecretsManagerClient({ endpoint: env('AWS_ENDPOINT_URL'), region: env('AWS_REGION') });
  for (;;) {
    try {
      const r = await cliente.send(new GetSecretValueCommand({ SecretId: nome }));
      return JSON.parse(r.SecretString ?? '{}') as T;
    } catch (e) {
      log?.warn({ err: (e as Error).message, segredo: nome }, 'segredo indisponível; tentando de novo');
      await dormir(2000);
    }
  }
}
