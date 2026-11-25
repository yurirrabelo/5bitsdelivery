// Carga contínua: PEDIDOS_POR_MIN pedidos por minuto durante DURACAO, cada um de um cliente do QR diferente.
// Usado no F6 (RabbitMQ fora) e no F8 (escala do pagamento).
//   docker compose --profile carga run --rm -e PEDIDOS_POR_MIN=60 -e DURACAO=60s k6 run /carga/carga-continua.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://nginx';
const JSON_H = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  scenarios: {
    constante: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.PEDIDOS_POR_MIN || 60),
      timeUnit: '1m',
      duration: __ENV.DURACAO || '60s',
      preAllocatedVUs: 20,
      maxVUs: 300,
    },
  },
};

const aceitos = new Counter('pedidos_aceitos'); // 202
const recusados = new Counter('pedidos_com_erro'); // qualquer outra resposta

export default function () {
  const sessao = http.post(`${BASE}/api/auth/cliente`, JSON.stringify({ apelido: `c${__VU}-${__ITER}`, codigo: __ENV.EVENTO_CODIGO }), JSON_H);
  if (sessao.status !== 200) {
    recusados.add(1);
    return;
  }
  const r = http.post(`${BASE}/api/pedidos`, '{}', { headers: { Authorization: `Bearer ${sessao.json('token')}`, 'Content-Type': 'application/json' } });
  const ok = check(r, { 'pedido aceito (202)': (x) => x.status === 202 });
  (ok ? aceitos : recusados).add(1);
}

export function handleSummary(data) {
  const v = (n) => (data.metrics[n] ? data.metrics[n].values.count : 0);
  return { stdout: `\nRESUMO ${JSON.stringify({ aceitos: v('pedidos_aceitos'), erros: v('pedidos_com_erro') })}\n` };
}
