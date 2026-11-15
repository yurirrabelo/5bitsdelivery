#!/usr/bin/env bash
# Roda os testes unitários e de integração das bibliotecas e serviços, tudo em containers
# (não exige Java nem Node na máquina). Usa um Postgres e um RabbitMQ descartáveis
# (docker-compose.test.yml); o sistema real não é tocado.
set -uo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.test.yml"
resultado=0

$COMPOSE down -v >/dev/null 2>&1

echo "=============== TypeScript (commons e serviços) ==============="
$COMPOSE run --rm testes-ts || resultado=1

echo
echo "=============== Java (commons e serviços) ==============="
$COMPOSE run --rm testes-java || resultado=1

$COMPOSE down -v >/dev/null 2>&1

echo
if [ "$resultado" -eq 0 ]; then
  echo "TESTES: PASSOU"
else
  echo "TESTES: FALHOU"
fi
exit "$resultado"
