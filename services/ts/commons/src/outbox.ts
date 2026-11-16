import {
  ROOT_CONTEXT,
  SpanKind,
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Pool } from 'pg';
import { Publicador } from './broker';
import { Queryable, transacao } from './db';
import { Envelope } from './envelope';
import { Logger } from './logger';
import { definirOutboxPendentes } from './metricas';

const w3c = new W3CTraceContextPropagator();
const tracer = trace.getTracer('delivery.commons');

function traceparentAtual(): string | undefined {
  const carrier: Record<string, string> = {};
  w3c.inject(context.active(), carrier, defaultTextMapSetter);
  return carrier.traceparent;
}

// Grava a mensagem na outbox, dentro da transação do efeito (use o mesmo client).
// O traceparent do trace ativo vai junto, para o trace não quebrar na outbox.
// Sem trace ativo (ex.: um agendador), usa o traceparentPadrao (o guardado no pedido).
export async function publicarNaOutbox(c: Queryable, envelope: Envelope, traceparentPadrao?: string | null): Promise<void> {
  await c.query('INSERT INTO outbox (message_id, type, payload, traceparent) VALUES ($1, $2, $3, $4)', [
    envelope.messageId,
    envelope.type,
    JSON.stringify(envelope),
    traceparentAtual() ?? traceparentPadrao ?? null,
  ]);
}

export interface OpcoesPublicador {
  exchange: string;
  intervaloMs?: number;
  lote?: number;
}

// Lê as pendentes (FOR UPDATE SKIP LOCKED, funciona igual com réplicas), publica com confirm e marca como publicada.
export class PublicadorOutbox {
  private ativo = false;
  private timer?: NodeJS.Timeout;
  private ultimaContagem = 0;
  private ultimoAviso = 0;

  constructor(
    private readonly pool: Pool,
    private readonly broker: Publicador,
    private readonly log: Logger,
    private readonly opcoes: OpcoesPublicador,
  ) {}

  iniciar(): void {
    this.ativo = true;
    this.agendar(0);
  }

  parar(): void {
    this.ativo = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private agendar(ms: number): void {
    if (!this.ativo) return;
    this.timer = setTimeout(() => {
      this.ciclo()
        .catch((e) => this.avisar(e))
        .finally(() => this.agendar(this.opcoes.intervaloMs ?? 200));
    }, ms);
  }

  // Um ciclo: publica um lote. Devolve quantas mensagens saíram. Público para os testes.
  async ciclo(): Promise<number> {
    if (!this.broker.conectado()) {
      await this.atualizarContagem();
      return 0;
    }
    const publicadas = await transacao(this.pool, async (c) => {
      const lote = this.opcoes.lote ?? 50;
      const r = await c.query(
        'SELECT id, payload, traceparent FROM outbox WHERE publicada_em IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [lote],
      );
      const feitas: number[] = [];
      try {
        for (const linha of r.rows) {
          await this.publicarUma(linha.payload as Envelope, linha.traceparent as string | null);
          feitas.push(Number(linha.id));
        }
      } catch (e) {
        this.avisar(e); // marca só as que saíram; as demais ficam para o próximo ciclo
      }
      if (feitas.length) await c.query('UPDATE outbox SET publicada_em = now() WHERE id = ANY($1::bigint[])', [feitas]);
      return feitas.length;
    });
    await this.atualizarContagem();
    return publicadas;
  }

  private async publicarUma(envelope: Envelope, traceparent: string | null): Promise<void> {
    const pai = traceparent ? w3c.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter) : ROOT_CONTEXT;
    await tracer.startActiveSpan('outbox publicar', { kind: SpanKind.PRODUCER }, pai, async (span) => {
      try {
        span.setAttribute('messaging.message.id', envelope.messageId);
        if (envelope.payload?.pedidoId !== undefined) span.setAttribute('pedido.id', Number(envelope.payload.pedidoId));
        await this.broker.publicar(this.opcoes.exchange, envelope.type, JSON.stringify(envelope), {
          messageId: envelope.messageId,
          correlationId: envelope.correlationId,
          type: envelope.type,
          traceparent: traceparentAtual() ?? traceparent ?? undefined,
        });
      } finally {
        span.end();
      }
    });
  }

  private async atualizarContagem(): Promise<void> {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM outbox WHERE publicada_em IS NULL');
    this.ultimaContagem = r.rows[0].n;
    definirOutboxPendentes(this.ultimaContagem);
  }

  // No máximo um aviso a cada 5 s, para o log não encher com o broker fora do ar
  private avisar(e: unknown): void {
    const agora = Date.now();
    if (agora - this.ultimoAviso < 5000) return;
    this.ultimoAviso = agora;
    this.log.warn({ err: (e as Error).message }, 'outbox: não consegui publicar; as mensagens esperam');
  }
}
