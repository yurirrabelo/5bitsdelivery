#!/usr/bin/env bash
# Bônus: versionamento de eventos. O pedido.confirmado ganhou a versão 2 (os dados de entrega passam para o
# objeto "entrega"). O pedidos publica a v2; as entregas entendem v1 e v2 (convertem a v1 ao ler); o estoque
# nunca foi alterado e segue funcionando (só usa o pedidoId). Este script publica uma v1 e uma v2 e mostra as
# duas processadas pelos dois consumidores.
source "$(dirname "$0")/../falhas/lib.sh"
trap 'finalizar_entregas; restaurar' EXIT

# conclui as entregas de teste para liberar os entregadores
finalizar_entregas() {
  for p in "${V1:-}" "${V2:-}"; do [ -n "$p" ] && api POST "/api/entregas/$p/confirmar" >/dev/null 2>&1; done
}

# publica um pedido.confirmado na versão pedida (a lib publica sempre a v1)
publicar_confirmado() { # publicar_confirmado versao messageId payload_json
  local env corpo
  env="{\"messageId\":\"$2\",\"correlationId\":\"$(uuid)\",\"type\":\"pedido.confirmado\",\"version\":$1,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"payload\":$3}"
  corpo=$(printf '{"properties":{"message_id":"%s","content_type":"application/json","delivery_mode":2},"routing_key":"pedido.confirmado","payload":%s,"payload_encoding":"string"}' \
    "$2" "$(printf '%s' "$env" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")
  rabbit_api POST "/api/exchanges/%2F/$(var RABBITMQ_EXCHANGE)/publish" "$corpo" >/dev/null
}

titulo "Bônus - versionamento de eventos" "pedido.confirmado v1 e v2 convivem: os dois consumidores processam as duas versões"
login_operador
limpar_entregas_de_teste
esperar_ate "[ \"\$(sql entregas \"SELECT count(*) FROM entregadores WHERE status = 'DISPONIVEL'\")\" = 2 ]" 30

V1=$((9100000 + RANDOM)); V2=$((9200000 + RANDOM))
M1=$(uuid); M2=$(uuid)
ORIGEM='{"nome":"Loja","lat":-26.9194,"lon":-49.0661}'
DESTINO='{"lat":-26.9100,"lon":-49.0700,"endereco":null}'

echo "Passo 1: publica um pedido.confirmado v1 (destino no payload, entregador preferido 1)"
publicar_confirmado 1 "$M1" "{\"pedidoId\":$V1,\"origem\":$ORIGEM,\"destino\":$DESTINO,\"entregadorPreferidoId\":1}"
echo "Passo 2: publica um pedido.confirmado v2 (dados dentro de \"entrega\", entregador preferido 2)"
publicar_confirmado 2 "$M2" "{\"pedidoId\":$V2,\"origem\":$ORIGEM,\"entrega\":{\"destino\":$DESTINO,\"entregadorPreferidoId\":2}}"

esperar_ate "[ \"\$(sql entregas \"SELECT count(*) FROM entregas WHERE pedido_id IN ($V1,$V2) AND status = 'ATRIBUIDA'\")\" = 2 ]" 30
esperar_ate "[ \"\$(sql estoque \"SELECT count(*) FROM mensagens_processadas WHERE message_id IN ('$M1','$M2')\")\" = 2 ]" 30

echo
echo "Resultado:"
verificar "estoque (nunca alterado) processou a v1 e a v2" 2 "$(sql estoque "SELECT count(*) FROM mensagens_processadas WHERE message_id IN ('$M1','$M2')")"
verificar "entregas processou a v1 e a v2 (inbox)" 2 "$(sql entregas "SELECT count(*) FROM mensagens_processadas WHERE message_id IN ('$M1','$M2')")"
verificar "entrega da v1 atribuída ao entregador preferido (1)" 1 "$(sql entregas "SELECT entregador_id FROM entregas WHERE pedido_id = $V1")"
verificar "entrega da v2 atribuída ao entregador preferido (2)" 2 "$(sql entregas "SELECT entregador_id FROM entregas WHERE pedido_id = $V2")"
verificar "destino da v1 convertido para o formato novo" "-26.91" "$(sql entregas "SELECT destino_lat FROM entregas WHERE pedido_id = $V1")"
verificar "destino da v2 lido de entrega.destino" "-26.91" "$(sql entregas "SELECT destino_lat FROM entregas WHERE pedido_id = $V2")"

echo
echo "Passo 3: um pedido de verdade: o pedidos publica a v2"
id=$(criar_pedido_cliente)
esperar_status "$id" CONFIRMADO 30
verificar "pedido real chegou a CONFIRMADO" CONFIRMADO "$(status_pedido "$id")"
verificar "versão da mensagem pedido.confirmado publicada pelo pedidos" 2 \
  "$(sql pedidos "SELECT payload->>'version' FROM outbox WHERE type = 'pedido.confirmado' AND payload->'payload'->>'pedidoId' = '$id'")"

finalizar "Versionamento"
