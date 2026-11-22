#!/usr/bin/env bash
# Fluxo completo: um cliente pede (com endereço), o pedido é reservado e pago, o entregador 2 aceita e "dirige" até
# o destino, e o pedido termina ENTREGUE, com a rota no S3. Deixe o painel aberto para ver o marcador andando.
# Rode com os celulares dos entregadores desligados: o teste usa a conta do entregador 2.
# Opcional: ./scripts/smoke-test.sh --velocidade 60 --intervalo 2
cd "$(dirname "$0")/.."
docker compose --profile sim run --rm --build simulador smoke "$@"
