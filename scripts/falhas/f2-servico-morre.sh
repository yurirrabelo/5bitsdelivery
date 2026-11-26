#!/usr/bin/env bash
# F2: a réplica do pagamento morre no meio do processamento. Outra réplica assume, e o gateway cobra uma vez só.
source "$(dirname "$0")/lib.sh"
trap restaurar EXIT

titulo "F2 - serviço morre" "mata a réplica que pegou a mensagem: outra processa, com uma única cobrança"
login_operador
./scripts/reset-estoque.sh >/dev/null

echo "Passo 1: gateway com latência de 8 s (dá tempo de matar a réplica no meio)"
gateway_ajustar 8000 0
docker compose up -d --scale pagamento=2 pagamento >/dev/null 2>&1
esperar_saudavel pagamento 60

echo "Passo 2: cria um pedido"
id=$(criar_pedido_cliente)
echo "         pedido #$id criado"

echo "Passo 3: acha a réplica que pegou a mensagem (pelo log) e dá docker kill nela"
alvo=""
fim=$((SECONDS + 20))
while [ $SECONDS -lt $fim ] && [ -z "$alvo" ]; do
  for c in $(docker ps --filter "label=com.docker.compose.service=pagamento" --format '{{.Names}}'); do
    if docker logs "$c" 2>&1 | grep -q "\"pedidoId\":$id.*chamando o gateway"; then alvo="$c"; fi
  done
  [ -z "$alvo" ] && sleep 0.5
done
[ -n "$alvo" ] || { echo "Nenhuma réplica pegou o pedido #$id"; FALHAS=$((FALHAS + 1)); finalizar F2; exit 1; }
echo "         réplica: $alvo"
verificar "antes do kill o pedido ainda está sem resposta" AGUARDANDO_PAGAMENTO "$(status_pedido "$id")"
docker kill "$alvo" >/dev/null

echo "Passo 4: espera o pedido ser confirmado pela outra réplica (até 30 s)"
esperar_status "$id" CONFIRMADO 30

echo
echo "Resultado:"
verificar "status do pedido" CONFIRMADO "$(status_pedido "$id")"
verificar "pagamentos gravados para o pedido" 1 "$(sql pagamento "SELECT count(*) FROM pagamentos WHERE pedido_id = $id")"
verificar "pagamento aprovado" APROVADO "$(sql pagamento "SELECT status FROM pagamentos WHERE pedido_id = $id")"
g=$(gateway_cobrancas)
verificar "cobranças reais no gateway (chave $id)" 1 "$(echo "$g" | grep -o "\"pedidoId\":$id,[^}]*" | grep -o '"vezesCobrada":[0-9]*' | cut -d: -f2)"
verificar "chamadas ao gateway com a mesma chave (retomada)" 2 "$(echo "$g" | grep -o "\"pedidoId\":$id,[^}]*" | grep -o '"requisicoes":[0-9]*' | cut -d: -f2)"
echo
echo "Mesmo messageId em duas réplicas (logs):"
for c in $(docker ps -a --filter "label=com.docker.compose.service=pagamento" --format '{{.Names}}'); do
  echo "   $c: $(docker logs "$c" 2>&1 | grep -c "\"pedidoId\":$id.*chamando o gateway") chamada(s) ao gateway"
done

finalizar F2 "Grafana: \"Pagamentos por cópia\": uma cópia parou e a outra assumiu. Na tabela, clique no pedido: 2 linhas do gateway (as duas chamadas, com a mesma chave) e uma cobrança só."
