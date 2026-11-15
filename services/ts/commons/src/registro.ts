// Telemetria OpenTelemetry. Carregue ANTES do código do serviço:
//   node --require @delivery/commons/registro dist/main.js
// Auto-instrumentação de HTTP, Fastify, amqplib, pg, ioredis e pino. Traces, métricas e logs vão por OTLP
// para o coletor do lgtm (OTEL_EXPORTER_OTLP_ENDPOINT). OTEL_SERVICE_NAME dá o nome do serviço.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { hostname } from 'node:os';

process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??= 'http/protobuf';
process.env.OTEL_METRIC_EXPORT_INTERVAL ??= '10000';
process.env.OTEL_LOGS_EXPORTER ??= 'otlp';
// distingue as réplicas do pagamento nos gráficos
if (!process.env.OTEL_RESOURCE_ATTRIBUTES?.includes('service.instance.id')) {
  const extra = `service.instance.id=${hostname()}`;
  process.env.OTEL_RESOURCE_ATTRIBUTES = process.env.OTEL_RESOURCE_ATTRIBUTES
    ? `${process.env.OTEL_RESOURCE_ATTRIBUTES},${extra}`
    : extra;
}

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        // só o que mostra o caminho de cada passo
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const encerrar = () => void sdk.shutdown().finally(() => process.exit(0));
  process.once('SIGTERM', encerrar);
  process.once('SIGINT', encerrar);
}
