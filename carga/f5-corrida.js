// F5: N clientes (padrão 100) pedem o item com o cupom ao mesmo tempo, cada um com a própria sessão do QR.
// Com 10 itens com cupom, o esperado é exatamente 10 pedidos CONFIRMADO e o resto ESGOTADO.
//   docker compose --profile carga run --rm k6 run /carga/f5-corrida.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://nginx';
const CLIENTES = Number(__ENV.CLIENTES || 100);
const JSON_H = { headers: { 'Content-Type': 'application/json' } };
const CUPOM = '#' + (__ENV.PROMOCAO_CUPOM || 'promobcc'); // o cliente escreve o cupom: o pedido disputa os itens com cupom

export const options = {
  scenarios: { corrida: { executor: 'per-vu-iterations', vus: CLIENTES, iterations: 1, maxDuration: '120s' } },
  thresholds: { checks: ['rate>0.99'] },
};

const confirmados = new Counter('pedidos_confirmados');
const esgotados = new Counter('pedidos_esgotados');
const outros = new Counter('pedidos_outros');

// roda uma vez antes dos clientes: define o instante da largada
export function setup() {
  return { largada: Date.now() + 5000 };
}

export default function (dados) {
  // cada cliente entra com o seu apelido e o código do evento (o que o QR code leva)
  const sessao = http.post(`${BASE}/api/auth/cliente`, JSON.stringify({ apelido: `cliente${__VU}`, codigo: __ENV.EVENTO_CODIGO }), JSON_H);
  check(sessao, { 'sessão criada': (r) => r.status === 200 });
  const auth = { headers: { Authorization: `Bearer ${sessao.json('token')}` } };
  const comCorpo = { headers: { Authorization: `Bearer ${sessao.json('token')}`, 'Content-Type': 'application/json' } };

  // largada simultânea
  const falta = dados.largada - Date.now();
  if (falta > 0) sleep(falta / 1000);

  const criado = http.post(`${BASE}/api/pedidos`, JSON.stringify({ cupom: CUPOM }), comCorpo);
  check(criado, { 'pedido aceito (202)': (r) => r.status === 202 });
  const id = criado.json('id');

  // acompanha até um estado final
  let status = 'RECEBIDO';
  for (let i = 0; i < 80 && (status === 'RECEBIDO' || status === 'AGUARDANDO_PAGAMENTO'); i++) {
    sleep(0.5);
    status = http.get(`${BASE}/api/pedidos/${id}`, auth).json('status');
  }
  if (status === 'CONFIRMADO') confirmados.add(1);
  else if (status === 'ESGOTADO') esgotados.add(1);
  else outros.add(1);
}

export function handleSummary(data) {
  const v = (n) => (data.metrics[n] ? data.metrics[n].values.count : 0);
  const resumo = { clientes: CLIENTES, confirmados: v('pedidos_confirmados'), esgotados: v('pedidos_esgotados'), outros: v('pedidos_outros') };
  return { stdout: `\nRESUMO ${JSON.stringify(resumo)}\n` };
}
