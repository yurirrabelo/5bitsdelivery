CREATE TABLE pedidos (
  id                      BIGSERIAL PRIMARY KEY,
  status                  TEXT             NOT NULL,
  motivo                  TEXT,
  cliente_id              TEXT             NOT NULL,
  origem_lat              DOUBLE PRECISION NOT NULL,
  origem_lon              DOUBLE PRECISION NOT NULL,
  destino_lat             DOUBLE PRECISION,
  destino_lon             DOUBLE PRECISION,
  destino_endereco        TEXT,
  entregador_preferido_id INT,
  entregador_id           INT,
  correlation_id          UUID             NOT NULL,
  traceparent             TEXT,
  prazo_pagamento         TIMESTAMPTZ,
  criado_em               TIMESTAMPTZ      NOT NULL DEFAULT now(),
  atualizado_em           TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX pedidos_status_prazo ON pedidos (prazo_pagamento) WHERE status = 'AGUARDANDO_PAGAMENTO';
CREATE INDEX pedidos_cliente ON pedidos (cliente_id, status);

-- uma linha por transição de estado, com o correlationId do fluxo
CREATE TABLE historico (
  id             BIGSERIAL PRIMARY KEY,
  pedido_id      BIGINT      NOT NULL REFERENCES pedidos (id),
  de_status      TEXT,
  para_status    TEXT        NOT NULL,
  gatilho        TEXT        NOT NULL,
  correlation_id UUID        NOT NULL,
  ocorrido_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX historico_pedido ON historico (pedido_id, id);
