#!/usr/bin/env bash
# F6: o RabbitMQ para por 30 s com carga contínua. A API segue respondendo 202, as mensagens esperam na
# outbox, os serviços reconectam sozinhos (sem reinício) e nenhum pedido fica parado.
source "$(dirname "$0")/lib.sh"
limpar() {
  docker compose start rabbitmq >/dev/null 2>&1
  docker rm -f k6-f6 >/dev/null 2>&1
  repor_estoque
  restaurar
}
trap limpar EXIT

FORA_SEG=30
titulo "F6 - broker fora" "RabbitMQ parado por ${FORA_SEG} s com carga: a API aceita, a outbox cresce e drena, nada se perde"
login_operador
repor_estoque 500          # estoque grande: queremos pagamentos fluindo durante a carga
primeiro=$(( $(maior_pedido) + 1 ))

# o início de cada serviço antes da queda: se mudar, algum serviço reiniciou em vez de reconectar
inicios() { for s in pedidos estoque pagamento entregas; do for c in $(docker ps -q --filter "label=com.docker.compose.service=$s"); do docker inspect -f '{{.Name}} {{.State.StartedAt}}' "$c"; done; done | sort; }
antes=$(inicios)

echo "Passo 1: carga contínua de 60 pedidos/min por 75 s (k6, em segundo plano)"
docker rm -f k6-f6 >/dev/null 2>&1
docker compose --profile carga run -d --name k6-f6 -e PEDIDOS_POR_MIN=60 -e DURACAO=75s k6 run /carga/carga-continua.js >/dev/null
sleep 12

echo "Passo 2: para o RabbitMQ por ${FORA_SEG} s"
docker compose stop rabbitmq >/dev/null 2>&1
maximo=0
for i in $(seq 1 $((FORA_SEG / 3))); do
  sleep 3
  total=$(( $(outbox_pendentes pedidos) + $(outbox_pendentes estoque) ))
  [ "$total" -gt "$maximo" ] && maximo=$total
  printf '         t+%02ds  mensagens esperando nas outboxes: %s\n' $((i * 3)) "$total"
done
echo "         durante a queda, um pedido novo pela API:"
durante=$(criar_pedido_cliente)
verificar "API respondeu 202 com o broker fora (pedido criado)" true "$([ -n "$durante" ] && echo true || echo false)"

echo "Passo 3: RabbitMQ volta; os serviços reconectam sozinhos e a outbox drena"
docker compose start rabbitmq >/dev/null 2>&1
esperar_ate "[ \"\$(docker compose ps rabbitmq --format '{{.Health}}')\" = healthy ]" 90
esperar_ate "[ \$(( \$(outbox_pendentes pedidos) + \$(outbox_pendentes estoque) + \$(outbox_pendentes pagamento) )) = 0 ]" 90

echo "Passo 4: espera o k6 terminar e os pedidos assentarem"
docker wait k6-f6 >/dev/null
resumo=$(resumo_k6 "$(docker logs k6-f6 2>&1)")
echo "         resumo do k6: $resumo"
NAO_FINAIS="status IN ('RECEBIDO','AGUARDANDO_PAGAMENTO')"
esperar_ate "[ \"\$(contar_pedidos \"id >= $primeiro AND $NAO_FINAIS\")\" = 0 ]" 120

echo
echo "Resultado:"
verificar "erros da API durante a carga (k6)" 0 "$(campo "$resumo" erros)"
verificar "pedidos no banco = pedidos aceitos pela API (+1 do passo 2)" "$(( $(campo "$resumo" aceitos) + 1 ))" "$(contar_pedidos "id >= $primeiro")"
verificar "a outbox cresceu durante a queda" true "$([ "$maximo" -gt 0 ] && echo true || echo false)"
verificar "outbox drenada (pedidos, estoque, pagamento)" 0 "$(( $(outbox_pendentes pedidos) + $(outbox_pendentes estoque) + $(outbox_pendentes pagamento) ))"
verificar "serviços reconectaram sozinhos (nenhum reiniciou)" sim "$([ "$antes" = "$(inicios)" ] && echo sim || echo NAO)"
verificar "pedidos parados (não finais)" 0 "$(contar_pedidos "id >= $primeiro AND $NAO_FINAIS")"
echo
echo "Pedidos desta carga por status final:"
sql pedidos "SELECT status || ': ' || count(*) FROM pedidos WHERE id >= $primeiro GROUP BY status ORDER BY 1" | sed 's/^/   /'

finalizar F6
