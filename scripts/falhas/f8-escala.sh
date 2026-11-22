#!/usr/bin/env bash
# F8: três réplicas do pagamento dividindo a carga, com o gateway levando 1 s por cobrança.
# Nenhum pagamento duplicado e nenhuma cobrança repetida no gateway.
source "$(dirname "$0")/lib.sh"
trap 'repor_estoque; restaurar' EXIT

REPLICAS=3
titulo "F8 - escala" "${REPLICAS} réplicas do pagamento, gateway com 1 s de latência: carga dividida, sem duplicar"
login_operador
repor_estoque 1000
echo "Passo 1: gateway com 1 s de latência e ${REPLICAS} réplicas do pagamento"
gateway_ajustar 1000 0
docker compose up -d --scale pagamento=$REPLICAS pagamento >/dev/null 2>&1
esperar_ate "[ \"\$(docker ps -q --filter label=com.docker.compose.service=pagamento | wc -l | tr -d ' ')\" = $REPLICAS ]" 60
esperar_saudavel pagamento 60
primeiro=$(( $(maior_pedido) + 1 ))
inicio=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Passo 2: carga de 120 pedidos/min por 45 s (k6)"
resumo=$(resumo_k6 "$(k6 carga-continua.js -e PEDIDOS_POR_MIN=120 -e DURACAO=45s)")
echo "         resumo do k6: $resumo"

echo "Passo 3: espera todos os pedidos terminarem (até 90 s)"
esperar_ate "[ \"\$(contar_pedidos \"id >= $primeiro AND status IN ('RECEBIDO','AGUARDANDO_PAGAMENTO')\")\" = 0 ]" 90

echo
echo "Resultado:"
total=$(contar_pedidos "id >= $primeiro")
verificar "pedidos aceitos pela API = pedidos no banco" "$(campo "$resumo" aceitos)" "$total"
verificar "réplicas do pagamento no ar" "$REPLICAS" "$(docker ps -q --filter label=com.docker.compose.service=pagamento | wc -l | tr -d ' ')"
soma=0
for c in $(docker ps --filter "label=com.docker.compose.service=pagamento" --format '{{.Names}}' | sort); do
  n=$(docker logs --since "$inicio" "$c" 2>&1 | grep -c '"msg":"pagamento aprovado"')
  printf '         %s processou %s pagamentos\n' "$c" "$n"
  [ "$n" -gt 0 ] || { echo "  [ERRO] a réplica $c não recebeu nenhuma mensagem"; FALHAS=$((FALHAS + 1)); }
  soma=$((soma + n))
done
verificar "soma dos pagamentos das réplicas = pedidos CONFIRMADOS" "$(contar_pedidos "id >= $primeiro AND status = 'CONFIRMADO'")" "$soma"
verificar "pagamentos duplicados no banco (mesmo pedido mais de uma vez)" 0 "$(sql pagamento "SELECT count(*) - count(DISTINCT pedido_id) FROM pagamentos WHERE pedido_id >= $primeiro")"
g=$(gateway_cobrancas)
verificar "chaves cobradas mais de uma vez no gateway" 0 "$(echo "$g" | grep -o '"vezesCobrada":[2-9]' | wc -l | tr -d ' ')"
verificar "cobranças no gateway = pagamentos aprovados" "$(sql pagamento "SELECT count(*) FROM pagamentos WHERE pedido_id >= $primeiro AND status = 'APROVADO'")" "$(echo "$g" | grep -o '"vezesCobrada":1' | wc -l | tr -d ' ')"

finalizar F8 "Grafana → Detalhes técnicos → \"Mensagens processadas por réplica do pagamento\": três réplicas dividiram a carga, sem cobrança duplicada."
