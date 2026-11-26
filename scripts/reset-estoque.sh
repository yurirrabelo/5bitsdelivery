#!/usr/bin/env bash
# Repõe os itens para os testes (limpa as reservas): ITEM_QUANTIDADE itens no total (30), dos quais PROMOCAO_QUANTIDADE (10)
# são os itens com cupom e o resto são os itens normais.
# Opcional: ./scripts/reset-estoque.sh 1000   (outra quantidade no total; os itens com cupom continuam sendo PROMOCAO_QUANTIDADE)
cd "$(dirname "$0")/.."
valor() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
QTD="${1:-$(valor ITEM_QUANTIDADE)}"
QTD="${QTD:-30}"
PROMO="$(valor PROMOCAO_QUANTIDADE)"
PROMO="${PROMO:-10}"
[ "$PROMO" -gt "$QTD" ] && PROMO="$QTD"
NORMAIS=$((QTD - PROMO))

docker compose exec -T pg-estoque psql -v ON_ERROR_STOP=1 -q -U estoque -d estoque <<SQL
BEGIN;
DELETE FROM reservas;
UPDATE estoque SET total = $NORMAIS, disponivel = $NORMAIS, reservado = 0, vendido = 0 WHERE produto_id = 1;
UPDATE estoque SET total = $PROMO, disponivel = $PROMO, reservado = 0, vendido = 0 WHERE produto_id = 2;
COMMIT;
SQL
echo "Estoque reposto: $QTD itens ($PROMO com cupom e $NORMAIS normais)."
