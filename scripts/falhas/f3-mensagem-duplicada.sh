#!/usr/bin/env bash
# F3: a mesma mensagem estoque.reservar publicada 5 vezes, com o mesmo messageId, pela API do RabbitMQ.
# A inbox garante um efeito só: uma reserva e quatro mensagens descartadas.
source "$(dirname "$0")/lib.sh"
trap 'repor_estoque; restaurar' EXIT

titulo "F3 - mensagem duplicada" "5 publicações com o mesmo messageId: um efeito e quatro descartadas"
login_operador
repor_estoque
antes=$(disponivel)

metrica() {
  docker exec delivery-tracker-lgtm-1 curl -s -G localhost:9090/api/v1/query     --data-urlencode 'query=sum(delivery_mensagens_total{service_name="estoque",resultado="duplicada"})' 2>/dev/null     | grep -o '"value":\[[^]]*\]' | grep -o '"[0-9.]*"\]' | tr -d '"]' | cut -d. -f1
}
m0=$(metrica); m0=${m0:-0}
MSG=$(uuid)
PEDIDO=$((9000000 + RANDOM))   # um pedido que não existe: só o estoque reage
inicio=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Passo 1: publica a mesma mensagem 5 vezes (messageId $MSG)"
for i in 1 2 3 4 5; do publicar_mensagem estoque.reservar "$MSG" "{\"pedidoId\":$PEDIDO}"; done

echo "Passo 2: espera o estoque processar"
esperar_ate "[ \"\$(sql estoque \"SELECT count(*) FROM mensagens_processadas WHERE message_id = '$MSG'\")\" = 1 ]" 20
sleep 3

echo
echo "Resultado:"
verificar "efeitos: reservas criadas para o pedido" 1 "$(sql estoque "SELECT count(*) FROM reservas WHERE pedido_id = $PEDIDO")"
verificar "unidades consumidas do estoque" 1 "$((antes - $(disponivel)))"
verificar "messageId registrado na inbox" 1 "$(sql estoque "SELECT count(*) FROM mensagens_processadas WHERE message_id = '$MSG'")"
verificar "respostas estoque.reservado na outbox" 1 "$(sql estoque "SELECT count(*) FROM outbox WHERE payload->'payload'->>'pedidoId' = '$PEDIDO'")"
descartadas=$(docker compose logs --since "$inicio" estoque 2>&1 | grep -c "mensagem duplicada descartada")
verificar "logs 'mensagem duplicada descartada'" 4 "$descartadas"

echo "Passo 3: a métrica delivery_mensagens_total{resultado=\"duplicada\"} (chega em até ~15 s)"
esperar_ate "[ -n \"\$(metrica)\" ] && [ \$((\$(metrica) - m0)) -ge 4 ]" 40
verificar "aumento da métrica de duplicadas do estoque" 4 "$(( $(metrica) - m0 ))"

finalizar F3 "Grafana → Detalhes técnicos → \"Duplicadas descartadas e erros\": subiu 4. O estoque reservou uma unidade só."
