CREATE TABLE IF NOT EXISTS entregadores (
  id               INT  PRIMARY KEY,
  nome             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DISPONIVEL' CHECK (status IN ('DISPONIVEL', 'OCUPADO', 'OFFLINE'))
);

CREATE TABLE IF NOT EXISTS entregas (
  pedido_id               BIGINT           PRIMARY KEY,
  entregador_id           INT REFERENCES entregadores (id),
  entregador_preferido_id INT,
  status                  TEXT             NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'ATRIBUIDA', 'CONCLUIDA')),
  origem_lat              DOUBLE PRECISION NOT NULL,
  origem_lon              DOUBLE PRECISION NOT NULL,
  destino_lat             DOUBLE PRECISION NOT NULL,
  destino_lon             DOUBLE PRECISION NOT NULL,
  correlation_id          UUID             NOT NULL,
  criada_em               TIMESTAMPTZ      NOT NULL DEFAULT now(),
  concluida_em            TIMESTAMPTZ,
  rota_exportada          BOOLEAN          NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS entregas_status ON entregas (status);

-- trajeto: cada posição recebida, ligada à entrega ativa do entregador (se houver)
CREATE TABLE IF NOT EXISTS posicoes (
  id             BIGSERIAL        PRIMARY KEY,
  entregador_id  INT              NOT NULL,
  pedido_id      BIGINT,
  lat            DOUBLE PRECISION NOT NULL,
  lon            DOUBLE PRECISION NOT NULL,
  velocidade_kmh DOUBLE PRECISION,
  precisao       DOUBLE PRECISION,
  ts             TIMESTAMPTZ      NOT NULL
);
CREATE INDEX IF NOT EXISTS posicoes_pedido ON posicoes (pedido_id, ts) WHERE pedido_id IS NOT NULL;
