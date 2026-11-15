import { Queryable } from './db';
import { Envelope } from './envelope';

// Registra o messageId. Devolve false se já foi processada (duplicada).
// Chame na MESMA transação do efeito: se o efeito falhar, o registro também some.
export async function registrarNaInbox(c: Queryable, envelope: Envelope): Promise<boolean> {
  const r = await c.query(
    'INSERT INTO mensagens_processadas (message_id, type) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING',
    [envelope.messageId, envelope.type],
  );
  return r.rowCount === 1;
}
