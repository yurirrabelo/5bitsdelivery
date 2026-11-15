import { randomUUID } from 'node:crypto';

// Envelope igual para toda mensagem (contracts/schemas/envelope.schema.json)
export interface Envelope<T = any> {
  messageId: string;
  correlationId: string;
  type: string;
  version: number;
  occurredAt: string;
  payload: T;
}

export function criarEnvelope<T>(type: string, correlationId: string, payload: T, version = 1): Envelope<T> {
  return {
    messageId: randomUUID(),
    correlationId,
    type,
    version,
    occurredAt: new Date().toISOString(),
    payload,
  };
}
