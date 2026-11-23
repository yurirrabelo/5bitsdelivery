#!/usr/bin/env bash
# Apaga a última posição de GPS de cada entregador. Ela fica no Redis (não no Postgres) e não tem prazo: sem apagar, o ponto
# de um teste ou de uma simulação antiga continua no mapa do painel como se fosse um entregador de verdade.
# Um celular de verdade volta ao mapa na próxima posição que mandar (de 3 em 3 s).
# O stream "posicoes" fica: o processador de GPS depende dele.
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
docker compose exec -T redis sh -c 'for k in $(redis-cli --scan --pattern "entregador:*"); do redis-cli del "$k" >/dev/null; done; redis-cli del entregadores:geo >/dev/null'
