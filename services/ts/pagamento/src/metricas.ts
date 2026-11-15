import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('delivery.pagamento');

// delivery_pagamentos_total{resultado}: aprovado | recusado | estornado
export const pagamentos = meter.createCounter('delivery_pagamentos_total', {
  description: 'Pagamentos por resultado',
});

// delivery_gateway_duracao_ms: quanto o gateway demorou para responder
export const duracaoGateway = meter.createHistogram('delivery_gateway_duracao_ms', {
  description: 'Duração das chamadas ao gateway de pagamento, em milissegundos',
});
