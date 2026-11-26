-- Pedido com o cupom (usa um dos itens com cupom) ou sem cupom (usa um dos itens normais).
-- Os pedidos que já existiam eram todos sem cupom.
ALTER TABLE pedidos ADD COLUMN promocao BOOLEAN NOT NULL DEFAULT FALSE;
