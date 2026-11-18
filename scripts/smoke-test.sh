#!/usr/bin/env bash
# Fluxo completo com o entregador simulado: cria o pedido, reserva, paga, despacha, "dirige" até o destino
# e confere se terminou ENTREGUE, com a rota no S3. Deixe o painel aberto para ver o marcador andando.
# Opcional: ./scripts/smoke-test.sh --velocidade 60 --intervalo 2
cd "$(dirname "$0")/.."
docker compose --profile sim run --rm --build simulador smoke "$@"
