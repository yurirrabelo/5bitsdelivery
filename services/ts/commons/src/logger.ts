import { trace } from '@opentelemetry/api';
import pino, { Logger } from 'pino';

export type { Logger };

// Logs em JSON no stdout com timestamp, level, service e trace_id.
// Os campos correlationId, messageId, type e pedidoId entram pelo logger.child(...).
export function criarLogger(servico: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: servico },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const span = trace.getActiveSpan();
      return span ? { trace_id: span.spanContext().traceId } : {};
    },
  });
}
