#!/usr/bin/env bash
# Deixa o sistema como no primeiro dia, SEM reiniciar nada (o link do túnel continua o mesmo): apaga os pedidos, as
# entregas e os trajetos de teste, repõe as unidades da promoção e deixa os entregadores livres.
# Use com o sistema parado (nenhum pedido em andamento): depois do ensaio e antes da apresentação.
# Opcional: ./scripts/limpar.sh 20   (outra quantidade de unidades)
cd "$(dirname "$0")/.."

./scripts/reset-estoque.sh "$@" || exit 1

docker compose exec -T pg-pedidos psql -v ON_ERROR_STOP=1 -q -U pedidos -d pedidos <<SQL
BEGIN;
DELETE FROM historico;
DELETE FROM pedidos;
COMMIT;
SQL

docker compose exec -T pg-entregas psql -v ON_ERROR_STOP=1 -q -U entregas -d entregas <<SQL
BEGIN;
DELETE FROM posicoes;
DELETE FROM entregas;
UPDATE entregadores SET status = 'DISPONIVEL' WHERE status = 'OCUPADO';
COMMIT;
SQL
echo "Pedidos, entregas e trajetos apagados. Entregadores livres."
