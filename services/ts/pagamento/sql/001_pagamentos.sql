CREATE TABLE IF NOT EXISTS pagamentos (
  pedido_id     BIGINT      PRIMARY KEY,
  status        TEXT        NOT NULL CHECK (status IN ('APROVADO', 'RECUSADO', 'ESTORNADO')),
  referencia    TEXT,
  motivo        TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
