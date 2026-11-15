import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { Ponto, extrairLinha, passoM, percorrer, reta } from './rota';

// Simulador de entregador. Envia posições para o mesmo caminho do Traccar (GET /gps).
//   rota  --arquivo <geojson|s3://bucket/chave> --device <id> --velocidade <km/h> --intervalo <s>
//   smoke [--velocidade 120] [--intervalo 1]      fluxo completo com o entregador simulado (entregador 2)

const env = (n: string, p?: string) => process.env[n] ?? p ?? (() => { throw new Error(`variável ${n} não definida`); })();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function argumentos(args: string[]): Record<string, string> {
  const a: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) a[args[i].slice(2)] = args[i + 1] ?? 'true';
  return a;
}

const s3 = () => new S3Client({ endpoint: env('AWS_ENDPOINT_URL'), region: env('AWS_REGION'), forcePathStyle: true });

async function carregarRota(arquivo: string): Promise<Ponto[]> {
  if (arquivo.startsWith('s3://')) {
    const [bucket, ...resto] = arquivo.slice(5).split('/');
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: resto.join('/') }));
    return extrairLinha(JSON.parse(await r.Body!.transformToString()));
  }
  return extrairLinha(JSON.parse(readFileSync(arquivo, 'utf8')));
}

// speed do /gps é em NÓS (como o Traccar envia)
async function enviarPosicao(device: string, p: Ponto, kmh: number): Promise<void> {
  const q = new URLSearchParams({
    id: device, lat: String(p[1]), lon: String(p[0]), timestamp: String(Math.floor(Date.now() / 1000)),
    speed: String(kmh / 1.852), accuracy: '5',
  });
  const r = await fetch(`${env('GPS_URL')}?${q}`);
  if (!r.ok) throw new Error(`/gps respondeu ${r.status}`);
}

async function andar(linha: Ponto[], device: string, kmh: number, intervaloS: number): Promise<void> {
  const pontos = percorrer(linha, passoM(kmh, intervaloS));
  console.log(`Enviando ${pontos.length} posições como "${device}" a ${kmh} km/h (uma a cada ${intervaloS} s)`);
  for (const [i, p] of pontos.entries()) {
    await enviarPosicao(device, p, kmh);
    console.log(`  ${i + 1}/${pontos.length}  ${p[1].toFixed(5)}, ${p[0].toFixed(5)}`);
    if (i < pontos.length - 1) await dormir(intervaloS * 1000);
  }
}

// ---------------------------------------------------------------- smoke
async function api(token: string, metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${env('API_URL')}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

async function esperarStatus(token: string, id: number, alvo: string, segundos: number): Promise<string> {
  const fim = Date.now() + segundos * 1000;
  let ultimo = '';
  while (Date.now() < fim) {
    const st = (await api(token, 'GET', `/api/pedidos/${id}`)).json?.status ?? '?';
    if (st !== ultimo) console.log(`  pedido #${id}: ${st}`);
    ultimo = st;
    if (st === alvo) return st;
    await dormir(500);
  }
  return ultimo;
}

async function smoke(a: Record<string, string>): Promise<boolean> {
  const kmh = Number(a.velocidade ?? 120);
  const intervalo = Number(a.intervalo ?? 1);
  let ok = true;
  const verificar = (descricao: string, bom: boolean, detalhe = '') => {
    console.log(`  [${bom ? 'OK' : 'ERRO'}] ${descricao}${detalhe ? ' ' + detalhe : ''}`);
    if (!bom) ok = false;
  };

  const login = await fetch(`${env('API_URL')}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env('OPERADOR_USUARIO'), password: env('OPERADOR_SENHA') }),
  });
  const token = ((await login.json()) as any).token as string;
  verificar('login do operador', !!token);
  if (!token) return false;

  const cfg = (await api(token, 'GET', '/api/pedidos/config')).json;
  const origem: Ponto = [cfg.origem.lon, cfg.origem.lat];
  const destino: Ponto = [origem[0] + 0.004, origem[1] + 0.004]; // uns 600 m da loja

  console.log('1. cria o pedido para o entregador simulado');
  const criado = await api(token, 'POST', '/api/pedidos', {
    destino: { lat: destino[1], lon: destino[0], endereco: 'Destino do smoke test' }, entregadorPreferidoId: 2,
  });
  verificar('POST /api/pedidos responde 202', criado.status === 202, `(#${criado.json?.id})`);
  const id = criado.json.id as number;

  console.log('2. espera o despacho (reserva -> pagamento -> confirmação -> entregador)');
  const emEntrega = await esperarStatus(token, id, 'EM_ENTREGA', 60);
  verificar('pedido chegou a EM_ENTREGA', emEntrega === 'EM_ENTREGA');
  if (emEntrega !== 'EM_ENTREGA') return false;

  console.log('3. o entregador "dirige" até o destino (mesmo caminho do Traccar: /gps)');
  await andar(reta(origem, destino), env('ENTREGADOR2_DEVICE_ID'), kmh, intervalo);

  console.log('4. espera a conclusão pelo geofence');
  const entregue = await esperarStatus(token, id, 'ENTREGUE', 30);
  verificar('pedido terminou ENTREGUE', entregue === 'ENTREGUE');

  console.log('5. confere a rota (API e S3)');
  const rota = (await api(token, 'GET', `/api/entregas/${id}/rota`)).json;
  verificar('rota na API tem posições', (rota?.geometry?.coordinates?.length ?? 0) > 1, `(${rota?.geometry?.coordinates?.length ?? 0} pontos)`);
  let noS3 = false;
  for (let i = 0; i < 40 && !noS3; i++) {
    try {
      await s3().send(new GetObjectCommand({ Bucket: env('S3_BUCKET_ROTAS'), Key: `rotas/pedido-${id}.geojson` }));
      noS3 = true;
    } catch {
      await dormir(1000);
    }
  }
  verificar(`rota exportada no S3 (rotas/pedido-${id}.geojson)`, noS3);
  return ok;
}

async function main() {
  const [comando, ...resto] = process.argv.slice(2);
  const a = argumentos(resto);
  if (comando === 'rota') {
    if (!a.arquivo || !a.device) throw new Error('uso: rota --arquivo <geojson|s3://bucket/chave> --device <id> [--velocidade 30] [--intervalo 3]');
    await andar(await carregarRota(a.arquivo), a.device, Number(a.velocidade ?? 30), Number(a.intervalo ?? 3));
  } else if (comando === 'smoke') {
    const ok = await smoke(a);
    console.log(ok ? '\nSMOKE: PASSOU' : '\nSMOKE: FALHOU');
    process.exit(ok ? 0 : 1);
  } else {
    console.log('comandos: rota | smoke');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
