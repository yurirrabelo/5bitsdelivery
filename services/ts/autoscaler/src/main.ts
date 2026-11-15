import { metrics } from '@opentelemetry/api';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigAutoescala, decidir } from './decisao';

// Autoescala do consumidor do pagamento: a cada intervalo lê o tamanho de pagamento.entrada no RabbitMQ e ajusta
// o número de réplicas entre um mínimo e um máximo, com espera mínima entre mudanças. Cada decisão vai para o log
// e a métrica delivery_autoscaler_replicas.
//
// Usa o Docker CLI pelo socket do Docker. As réplicas do compose (as de base) nunca são removidas: o autoescalador
// só cria e remove as extras, clonando a configuração de uma réplica de base. Reduzir é seguro: uma réplica parada
// no meio do processamento devolve a mensagem para a fila (como no F2) e a inbox descarta repetições.

const execFileP = promisify(execFile);
const env = (n: string, p?: string) => process.env[n] ?? p ?? (() => { throw new Error(`variável ${n} não definida`); })();

const cfg: ConfigAutoescala = {
  min: Number(env('AUTOSCALE_MIN', '2')),
  max: Number(env('AUTOSCALE_MAX', '6')),
  mensagensPorReplica: Number(env('AUTOSCALE_MENSAGENS_POR_REPLICA', '10')),
  esperaSeg: Number(env('AUTOSCALE_ESPERA_SEG', '15')),
};
const INTERVALO_MS = Number(env('AUTOSCALE_INTERVALO_SEG', '5')) * 1000;
const FILA = env('FILA_PAGAMENTO');
const SERVICO = 'pagamento';

const log = (nivel: string, msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ level: nivel, timestamp: new Date().toISOString(), service: 'autoscaler', msg, ...extra }));

const docker = async (args: string[]): Promise<string> => (await execFileP('docker', args, { maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
const ids = async (filtros: string[]): Promise<string[]> =>
  (await docker(['ps', '-q', ...filtros.flatMap((f) => ['--filter', f])])).split('\n').filter(Boolean);

const composeFiltros = [`label=com.docker.compose.service=${SERVICO}`, 'status=running'];
const extraFiltros = [`label=delivery.autoscaler=${SERVICO}`, 'status=running'];

// A imagem do pagamento já traz os labels do Compose (projeto e serviço). Por isso as réplicas de base são as
// do compose MENOS as extras: sem isso as extras seriam contadas como "de base".
async function replicasDeBase(): Promise<string[]> {
  const extras = new Set(await ids(extraFiltros));
  return (await ids(composeFiltros)).filter((id) => !extras.has(id));
}

async function mensagensNaFila(): Promise<number> {
  const auth = Buffer.from(`${env('RABBITMQ_USUARIO')}:${env('RABBITMQ_SENHA')}`).toString('base64');
  const r = await fetch(`${env('RABBITMQ_API_URL')}/api/queues/%2F/${encodeURIComponent(FILA)}`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`API do RabbitMQ respondeu ${r.status}`);
  return ((await r.json()) as { messages_ready?: number }).messages_ready ?? 0;
}

// Cria uma réplica extra clonando a configuração de uma réplica de base
async function subirExtra(): Promise<string> {
  const [base] = await replicasDeBase();
  if (!base) throw new Error('nenhuma réplica de base do pagamento para clonar');
  const info = JSON.parse(await docker(['inspect', base]))[0];
  const rede = Object.keys(info.NetworkSettings.Networks)[0];
  const nome = `delivery-tracker-${SERVICO}-auto-${Date.now().toString(36)}`;
  const saude = info.Config.Healthcheck?.Test?.slice(1).join(' ');
  const args = [
    'run', '-d', '--name', nome, '--network', rede, '--restart', 'unless-stopped',
    '--label', `delivery.autoscaler=${SERVICO}`,
    // os labels do Compose herdados da imagem ficam em branco: o Compose não deve adotar esta réplica
    '--label', 'com.docker.compose.project=', '--label', 'com.docker.compose.service=',
    ...(saude ? ['--health-cmd', saude, '--health-interval', '5s', '--health-timeout', '3s', '--health-retries', '20'] : []),
    ...info.Config.Env.flatMap((e: string) => ['-e', e]),
    info.Config.Image,
  ];
  await docker(args);
  return nome;
}

// Remove a extra mais nova (uma réplica parada no meio de uma mensagem devolve a mensagem para a fila)
async function descerExtra(): Promise<string | null> {
  const extras = await ids(extraFiltros);
  if (!extras.length) return null;
  const nome = (await docker(['inspect', '-f', '{{.Name}}', extras[0]])).replace(/^\//, '');
  await docker(['stop', '-t', '30', extras[0]]);
  await docker(['rm', extras[0]]);
  return nome;
}

let replicasAtuais = 0;
metrics
  .getMeter('delivery.autoscaler')
  .createObservableGauge('delivery_autoscaler_replicas', { description: 'Réplicas do pagamento (base + extras)' })
  .addCallback((r) => r.observe(replicasAtuais));

async function main() {
  log('info', 'autoscaler no ar', { ...cfg, intervaloSeg: INTERVALO_MS / 1000, fila: FILA });
  let ultimaMudanca = 0; // a primeira decisão não precisa esperar
  for (;;) {
    try {
      const mensagens = await mensagensNaFila();
      const base = (await replicasDeBase()).length;
      const extras = (await ids(extraFiltros)).length;
      replicasAtuais = base + extras;
      const d = decidir(mensagens, replicasAtuais, ultimaMudanca, Date.now(), { ...cfg, min: Math.max(cfg.min, base) });

      if (d.acao === 'manter') {
        log('info', d.motivo, { mensagens, replicas: replicasAtuais, acao: d.acao });
      } else if (d.acao === 'subir') {
        for (let i = replicasAtuais; i < d.alvo; i++) log('info', `subindo ${await subirExtra()}`, { mensagens });
        ultimaMudanca = Date.now();
        replicasAtuais = d.alvo;
        log('warn', d.motivo, { mensagens, replicas: d.alvo, acao: d.acao });
      } else {
        const removida = await descerExtra();
        if (removida) {
          ultimaMudanca = Date.now();
          replicasAtuais = d.alvo;
          log('warn', `${d.motivo}; removida ${removida}`, { mensagens, replicas: d.alvo, acao: d.acao });
        }
      }
    } catch (e) {
      log('warn', `ciclo falhou: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }
}

main();
