-- A invariante disponivel + reservado + vendido = total é garantida também pelo banco
CREATE TABLE estoque (
  produto_id INT  PRIMARY KEY,
  nome       TEXT NOT NULL,
  total      INT  NOT NULL,
  disponivel INT  NOT NULL,
  reservado  INT  NOT NULL DEFAULT 0,
  vendido    INT  NOT NULL DEFAULT 0,
  CONSTRAINT estoque_invariante CHECK (
    disponivel >= 0 AND reservado >= 0 AND vendido >= 0 AND disponivel + reservado + vendido = total)
);

-- uma reserva por pedido: impede reservar duas vezes para o mesmo pedido
CREATE TABLE reservas (
  pedido_id     BIGINT      PRIMARY KEY,
  produto_id    INT         NOT NULL REFERENCES estoque (produto_id),
  status        TEXT        NOT NULL CHECK (status IN ('RESERVADA', 'CONFIRMADA', 'LIBERADA')),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
