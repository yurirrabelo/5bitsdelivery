#!/usr/bin/env bash
# Roda todos os cenários de falha em sequência e mostra o resumo. Termina com 0 só se todos passarem.
# Cada cenário devolve a configuração normal ao terminar. Leva uns 12 minutos.
cd "$(dirname "$0")/../.."

CENARIOS="f1-compensacao f2-servico-morre f3-mensagem-duplicada f4-mensagem-venenosa f5-corrida f6-broker-fora f6b-ministack-fora f7-resposta-tardia f8-escala"
RESUMO=""
FALHOU=0

for c in $CENARIOS; do
  echo
  echo "##################################################################"
  echo "# $c"
  echo "##################################################################"
  if ./scripts/falhas/$c.sh; then
    RESUMO="$RESUMO\n  PASSOU  $c"
  else
    RESUMO="$RESUMO\n  FALHOU  $c"
    FALHOU=1
  fi
  sleep 5   # deixa o sistema assentar entre os cenários
done

echo
echo "=================== RESUMO ==================="
printf '%b\n' "$RESUMO"
echo
if [ "$FALHOU" -eq 0 ]; then echo "TODOS OS CENÁRIOS: PASSOU"; else echo "TODOS OS CENÁRIOS: FALHOU"; fi
exit "$FALHOU"
