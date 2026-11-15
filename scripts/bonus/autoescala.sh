#!/usr/bin/env bash
# Bônus: autoescala do consumidor do pagamento. Com o gateway lento e carga, a fila pagamento.entrada sobe,
# o autoescalador sobe réplicas; quando a fila esvazia, ele as remove. Acompanhe no painel "Delivery ao vivo".
source "$(dirname "$0")/../falhas/lib.sh"
trap 'docker compose --profile bonus stop autoscaler >/dev/null 2>&1; docker ps -aq --filter label=delivery.autoscaler=pagamento | xargs -r docker rm -f >/dev/null 2>&1; repor_estoque; restaurar' EXIT

titulo "Bônus - autoescala" "gateway de 2 s + carga: a fila sobe, as réplicas sobem; a fila esvazia, as réplicas descem"
login_operador
repor_estoque 1000
base=$(docker ps -q --filter label=com.docker.compose.service=pagamento | wc -l | tr -d ' ')
replicas() { echo $(( $(docker ps -q --filter label=com.docker.compose.service=pagamento | wc -l) + $(docker ps -q --filter label=delivery.autoscaler=pagamento | wc -l) )); }

echo "Passo 1: gateway com 2 s de latência e o autoescalador no ar (mín ${base}, máx $(var AUTOSCALE_MAX))"
gateway_ajustar 2000 0
docker compose --profile bonus up -d --build autoscaler >/dev/null 2>&1
sleep 8
verificar "réplicas antes da carga" "$base" "$(replicas)"

echo "Passo 2: carga de 180 pedidos/min por 60 s (k6, em segundo plano)"
docker rm -f k6-auto >/dev/null 2>&1
docker compose --profile carga run -d --name k6-auto -e PEDIDOS_POR_MIN=180 -e DURACAO=60s k6 run /carga/carga-continua.js >/dev/null

maximo=$base
for i in $(seq 1 24); do
  sleep 5
  n=$(replicas); [ "$n" -gt "$maximo" ] && maximo=$n
  printf '         t+%03ds  fila pagamento.entrada: %-4s réplicas: %s\n' $((i * 5)) "$(fila_prontas "$(var FILA_PAGAMENTO)")" "$n"
done
docker wait k6-auto >/dev/null; docker rm -f k6-auto >/dev/null 2>&1

echo "Passo 3: a fila esvazia e as réplicas extras são removidas (até 3 min)"
esperar_ate "[ \"\$(fila_prontas $(var FILA_PAGAMENTO))\" = 0 ]" 120
esperar_ate "[ \"\$(replicas)\" = \"$base\" ]" 180

echo
echo "Decisões do autoescalador:"
docker compose --profile bonus logs autoscaler 2>&1 | grep -E '"level":"warn"' | sed -E 's/.*"msg":"([^"]*)".*/   \1/' | head -12

echo
echo "Resultado:"
verificar "o autoescalador subiu réplicas (máximo observado > base)" true "$([ "$maximo" -gt "$base" ] && echo true || echo false)"
verificar "a fila esvaziou" 0 "$(fila_prontas "$(var FILA_PAGAMENTO)")"
verificar "as réplicas voltaram ao número de base" "$base" "$(replicas)"
verificar "nenhum pagamento duplicado" 0 "$(sql pagamento "SELECT count(*) - count(DISTINCT pedido_id) FROM pagamentos")"
verificar "nenhuma chave cobrada duas vezes no gateway" 0 "$(gateway_cobrancas | grep -o '"vezesCobrada":[2-9]' | wc -l | tr -d ' ')"

finalizar "Autoescala"
