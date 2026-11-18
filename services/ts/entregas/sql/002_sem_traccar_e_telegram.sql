-- O GPS agora vem do navegador do entregador (JWT) e o aviso de nova entrega aparece na própria página.
-- Só limpa bancos criados antes disso; num banco novo, não há nada a remover.
ALTER TABLE entregadores DROP COLUMN IF EXISTS device_id;
ALTER TABLE entregadores DROP COLUMN IF EXISTS telegram_chat_id;
DROP TABLE IF EXISTS notificacoes;
