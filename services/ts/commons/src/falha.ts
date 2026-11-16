import { SpanStatusCode, trace } from '@opentelemetry/api';

// Marca o span ativo como falha de negócio (aparece em vermelho no Grafana), sem lançar erro:
// a mensagem continua sendo tratada normalmente.
export function marcarFalha(mensagem: string): void {
  trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: mensagem });
}
