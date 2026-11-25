-- Não existe mais promoção: todo pedido pede o item e reserva uma unidade do estoque.
ALTER TABLE pedidos DROP COLUMN promocao;
