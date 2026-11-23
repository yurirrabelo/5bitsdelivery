-- Pedido com cupom da promoção (usa uma das unidades do estoque) ou pedido normal (não usa o estoque da promoção).
-- Os pedidos que já existiam eram todos da promoção.
ALTER TABLE pedidos ADD COLUMN promocao BOOLEAN NOT NULL DEFAULT TRUE;
