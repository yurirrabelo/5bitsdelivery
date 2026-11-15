import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('delivery.commons');

// delivery_mensagens_total{type, resultado}: processada | duplicada | erro (uma série por instância)
export const mensagens = meter.createCounter('delivery_mensagens_total', {
  description: 'Mensagens consumidas, por tipo e resultado',
});

let pendentes = 0;
const gaugePendentes = meter.createObservableGauge('delivery_outbox_pendentes', {
  description: 'Mensagens esperando na outbox para serem publicadas',
});
gaugePendentes.addCallback((r) => r.observe(pendentes));

export function definirOutboxPendentes(n: number): void {
  pendentes = n;
}
