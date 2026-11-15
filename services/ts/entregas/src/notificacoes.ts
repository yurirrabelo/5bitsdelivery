import { Logger, Pool, transacao } from './comuns';

export interface Notificador {
  enviar(chatId: string | null, texto: string): Promise<void>;
}

// log (padrão): só registra a mensagem no log
export class NotificadorLog implements Notificador {
  constructor(private readonly log: Logger) {}
  async enviar(chatId: string | null, texto: string): Promise<void> {
    this.log.info({ chatId, texto }, 'notificação (provider log)');
  }
}

export class NotificadorTelegram implements Notificador {
  constructor(private readonly token: string) {}
  async enviar(chatId: string | null, texto: string): Promise<void> {
    if (!chatId) throw new Error('entregador sem telegram_chat_id');
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`telegram respondeu ${r.status}`);
  }
}

export class NotificadorNtfy implements Notificador {
  constructor(private readonly topico: string) {}
  async enviar(_chatId: string | null, texto: string): Promise<void> {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(this.topico)}`, {
      method: 'POST',
      body: texto,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`ntfy respondeu ${r.status}`);
  }
}

// Envia as notificações pendentes, com nova tentativa (espera dobra a cada falha, no máximo 60 s).
// O aviso é o gatilho da demo e não pode se perder: o mesmo padrão da outbox.
export async function enviarPendentes(pool: Pool, notificador: Notificador, log: Logger): Promise<number> {
  return transacao(pool, async (c) => {
    const r = await c.query(
      `SELECT n.id, n.texto, n.tentativas, e.telegram_chat_id
         FROM notificacoes n JOIN entregadores e ON e.id = n.entregador_id
        WHERE n.status = 'PENDENTE' AND n.proxima_tentativa <= now()
        ORDER BY n.id LIMIT 20 FOR UPDATE OF n SKIP LOCKED`,
    );
    let enviadas = 0;
    for (const n of r.rows) {
      try {
        await notificador.enviar(n.telegram_chat_id, n.texto);
        await c.query("UPDATE notificacoes SET status = 'ENVIADA', enviada_em = now() WHERE id = $1", [n.id]);
        enviadas++;
      } catch (e) {
        await c.query(
          "UPDATE notificacoes SET tentativas = tentativas + 1, proxima_tentativa = now() + make_interval(secs => LEAST(60, power(2, tentativas + 1))) WHERE id = $1",
          [n.id],
        );
        log.warn({ notificacaoId: n.id, tentativa: n.tentativas + 1, err: (e as Error).message }, 'notificação falhou; tento de novo');
      }
    }
    return enviadas;
  });
}
