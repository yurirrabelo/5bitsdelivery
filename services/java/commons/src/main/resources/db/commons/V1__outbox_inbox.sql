-- Tabelas de confiabilidade presentes em todo serviço que usa banco.
-- outbox.payload guarda o envelope completo da mensagem a publicar.
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  message_id   UUID        NOT NULL UNIQUE,
  type         TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  traceparent  TEXT,
  criada_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  publicada_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pendentes ON outbox (id) WHERE publicada_em IS NULL;

CREATE TABLE IF NOT EXISTS mensagens_processadas (
  message_id   UUID        PRIMARY KEY,
  type         TEXT        NOT NULL,
  processada_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
