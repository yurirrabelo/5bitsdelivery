#!/usr/bin/env bash
# Repõe as unidades do item (ITEM_QUANTIDADE) para os testes. Limpa as reservas.
# Opcional: ./scripts/reset-estoque.sh 20   (outra quantidade)
cd "$(dirname "$0")/.."
QTD="${1:-$(grep -E '^ITEM_QUANTIDADE=' .env | head -1 | cut -d= -f2-)}"
QTD="${QTD:-10}"

docker compose exec -T pg-estoque psql -v ON_ERROR_STOP=1 -q -U estoque -d estoque <<SQL
BEGIN;
DELETE FROM reservas;
UPDATE estoque SET total = $QTD, disponivel = $QTD, reservado = 0, vendido = 0 WHERE produto_id = 1;
COMMIT;
SQL
echo "Estoque reposto: $QTD unidades."
