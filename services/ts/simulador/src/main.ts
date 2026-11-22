import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { Ponto, extrairLinha, passoM, percorrer, reta } from './rota';

// Ferramenta de teste: faz o papel do celular. Entra com o usuário e a senha do entregador e envia as posições
// para POST /api/entregas/posicoes (o mesmo caminho do navegador do celular).
//   rota  --arquivo <geojson|s3://bucket/chave> [--entregador 1|2] [--velocidade 30] [--intervalo 3]
//         (plano B do GPS: aceita o pedido que estiver esperando, se o entregador ainda não tem entrega, e "dirige" a rota)
//   smoke [--velocidade 120] [--intervalo 1]      o fluxo completo: cliente pede, entregador 2 aceita e "dirige" até o destino
// Rode com os celulares dos entregadores desligados (ou fechados): o teste usa a conta do entregador 2.

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

async function entrar(usuario: string, senha: string): Promise<string> {
  const r = await fetch(`${env('API_URL')}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usuario, password: senha }),
  });
  const token = ((await r.json().catch(() => ({}))) as { token?: string }).token;
  if (!token) throw new Error(`não consegui entrar como "${usuario}" (login respondeu ${r.status})`);
  return token;
}

// Entra como o entregador 1 (o do celular) ou 2 (o simulado), com o usuário e a senha do .env
const entrarComoEntregador = (n: string) => entrar(env(`ENTREGADOR${n}_USUARIO`), env(`ENTREGADOR${n}_SENHA`));

// A velocidade vai em m/s, como a Geolocation API do navegador
async function enviarPosicao(token: string, p: Ponto, kmh: number): Promise<void> {
  const r = await fetch(`${env('API_URL')}/api/entregas/posicoes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: p[1], lon: p[0], precisao: 5, velocidade: kmh / 3.6 }),
  });
  if (!r.ok) throw new Error(`/api/entregas/posicoes respondeu ${r.status}`);
}

async function andar(linha: Ponto[], token: string, kmh: number, intervaloS: number): Promise<void> {
  const pontos = percorrer(linha, passoM(kmh, intervaloS));
  console.log(`Enviando ${pontos.length} posições a ${kmh} km/h (uma a cada ${intervaloS} s)`);
  for (const [i, p] of pontos.entries()) {
    await enviarPosicao(token, p, kmh);
    console.log(`  ${i + 1}/${pontos.length}  ${p[1].toFixed(5)}, ${p[0].toFixed(5)}`);
    if (i < pontos.length - 1) await dormir(intervaloS * 1000);
  }
}

// ---------------------------------------------------------------- smoke
async function api(token: string, metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${env('API_URL')}${caminho}`, {
    method: metodo,
    // sem corpo, sem Content-Type (como o navegador faz): o servidor recusa "application/json" vazio
    headers: { Authorization: `Bearer ${token}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
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

// Espera o pedido aparecer na lista do entregador (GET /api/entregas/me) e aceita (POST .../aceitar). Devolve o HTTP do aceite.
async function aceitarPedido(token: string, pedidoId: number, segundos: number): Promise<number> {
  const fim = Date.now() + segundos * 1000;
  while (Date.now() < fim) {
    const me = (await api(token, 'GET', '/api/entregas/me')).json;
    if ((me?.ofertas ?? []).some((o: { pedidoId: number }) => o.pedidoId === pedidoId)) {
      return (await api(token, 'POST', `/api/entregas/${pedidoId}/aceitar`)).status;
    }
    await dormir(500);
  }
  return 0;
}

// Plano B do GPS: se o entregador ainda não tem entrega, aceita o pedido mais antigo que estiver esperando por ele
// (como o toque em Aceitar). Sem nenhum pedido esperando, só envia a posição (o marcador anda no mapa, sem entrega).
async function garantirEntrega(token: string, segundos: number): Promise<void> {
  const fim = Date.now() + segundos * 1000;
  while (Date.now() < fim) {
    const me = (await api(token, 'GET', '/api/entregas/me')).json;
    if (me?.entrega) return console.log(`Entrega do pedido #${me.entrega.pedidoId} em andamento.`);
    const oferta = me?.ofertas?.[0];
    if (oferta && (await api(token, 'POST', `/api/entregas/${oferta.pedidoId}/aceitar`)).status === 200) {
      return console.log(`Aceitei o pedido #${oferta.pedidoId}.`);
    }
    await dormir(1000);
  }
  console.log('Nenhum pedido esperando por este entregador: enviando só a posição.');
}

async function smoke(a: Record<string, string>): Promise<boolean> {
  const kmh = Number(a.velocidade ?? 120);
  const intervalo = Number(a.intervalo ?? 1);
  let ok = true;
  const verificar = (descricao: string, bom: boolean, detalhe = '') => {
    console.log(`  [${bom ? 'OK' : 'ERRO'}] ${descricao}${detalhe ? ' ' + detalhe : ''}`);
    if (!bom) ok = false;
  };

  const token = await entrar(env('OPERADOR_USUARIO'), env('OPERADOR_SENHA'));
  verificar('login do operador', !!token);

  const cfg = (await api(token, 'GET', '/api/pedidos/config')).json;
  const origem: Ponto = [cfg.origem.lon, cfg.origem.lat];
  const destino: Ponto = [origem[0] + 0.004, origem[1] + 0.004]; // uns 600 m da loja

  console.log('1. um cliente (como o do QR code) pede, mandando o endereço dele');
  const rc = await fetch(`${env('API_URL')}/api/auth/cliente`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apelido: 'smoke', codigo: env('EVENTO_CODIGO') }),
  });
  const tokenCliente = ((await rc.json().catch(() => ({}))) as { token?: string }).token ?? '';
  verificar('o cliente entra com o código do evento', !!tokenCliente);
  const criado = await api(tokenCliente, 'POST', '/api/pedidos', { destino: { lat: destino[1], lon: destino[0] } });
  verificar('POST /api/pedidos responde 202', criado.status === 202, `(#${criado.json?.id})`);
  const id = criado.json.id as number;

  console.log('2. o pedido é reservado, pago e confirmado: a entrega fica esperando um entregador');
  const confirmado = await esperarStatus(tokenCliente, id, 'CONFIRMADO', 60);
  verificar('pedido chegou a CONFIRMADO', confirmado === 'CONFIRMADO');
  if (confirmado !== 'CONFIRMADO') return false;

  console.log('3. o entregador 2 vê o pedido na lista dele e toca em Aceitar');
  const tokenEntregador = await entrarComoEntregador('2');
  const aceite = await aceitarPedido(tokenEntregador, id, 30);
  verificar('o pedido apareceu para o entregador e ele aceitou', aceite === 200, `(HTTP ${aceite})`);
  const emEntrega = await esperarStatus(tokenCliente, id, 'EM_ENTREGA', 20);
  verificar('pedido foi para EM_ENTREGA', emEntrega === 'EM_ENTREGA');
  if (emEntrega !== 'EM_ENTREGA') return false;

  console.log('4. o entregador "dirige" até o destino (envia o GPS como o navegador do celular)');
  await andar(reta(origem, destino), tokenEntregador, kmh, intervalo);

  console.log('5. espera a conclusão pelo geofence');
  const entregue = await esperarStatus(tokenCliente, id, 'ENTREGUE', 30);
  verificar('pedido terminou ENTREGUE (o cliente vê)', entregue === 'ENTREGUE');

  console.log('6. confere a rota (API e S3)');
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
    if (!a.arquivo) throw new Error('uso: rota --arquivo <geojson|s3://bucket/chave> [--entregador 1|2] [--velocidade 30] [--intervalo 3]');
    const token = await entrarComoEntregador(a.entregador ?? '2');
    await garantirEntrega(token, 10);
    await andar(await carregarRota(a.arquivo), token, Number(a.velocidade ?? 30), Number(a.intervalo ?? 3));
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
