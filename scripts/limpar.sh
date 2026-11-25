#!/usr/bin/env bash
# Deixa o sistema como no primeiro dia, SEM reiniciar nada (o link do túnel continua o mesmo): apaga os pedidos, os
# pagamentos, as entregas, os trajetos e as posições de GPS de teste, repõe as unidades do item e deixa os entregadores livres.
# Use com o sistema parado (nenhum pedido em andamento): depois do ensaio e antes da apresentação.
# Os cenários de falha (./demo.sh falha N) rodam isto sozinhos antes de começar.
# Opcional: ./scripts/limpar.sh 20   (outra quantidade de unidades)
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

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

docker compose exec -T pg-pagamento psql -v ON_ERROR_STOP=1 -q -U pagamento -d pagamento <<SQL
DELETE FROM pagamentos;
SQL

# A última posição de cada entregador fica no Redis, não no Postgres: sem apagar, os pontos de testes antigos continuam
# no mapa do painel como se fossem entregadores de verdade.
./scripts/limpar-gps.sh || exit 1

# Bônus CQRS: a visão dos pedidos fica no DynamoDB (serviço "consultas"). Se ele estiver no ar, zera a visão também.
if [ -n "$(docker compose ps -q consultas 2>/dev/null)" ]; then
  docker compose exec -T consultas node - <<'JS' || exit 1
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION }));
const tabela = process.env.DYNAMODB_TABELA_VISAO;
(async () => {
  let inicio, apagados = 0;
  do {
    const r = await doc.send(new ScanCommand({ TableName: tabela, ProjectionExpression: 'pk', ExclusiveStartKey: inicio }));
    for (let i = 0; i < r.Items.length; i += 25) {
      const lote = r.Items.slice(i, i + 25);
      await doc.send(new BatchWriteCommand({ RequestItems: { [tabela]: lote.map((Key) => ({ DeleteRequest: { Key } })) } }));
      apagados += lote.length;
    }
    inicio = r.LastEvaluatedKey;
  } while (inicio);
  console.log('Visão CQRS (DynamoDB): ' + apagados + ' itens apagados.');
})().catch((e) => { console.error(e.message); process.exit(1); });
JS
fi
echo "Pedidos, pagamentos, entregas, trajetos e posições de GPS apagados. Entregadores livres."
