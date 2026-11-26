#!/usr/bin/env bash
# F7: o gateway demora mais que o prazo de pagamento. O pedido é cancelado no prazo e, quando a aprovação
# finalmente chega, ela é estornada.
source "$(dirname "$0")/lib.sh"
trap restaurar EXIT

PRAZO=$(var PRAZO_PAGAMENTO_SEG)
LATENCIA_MS=$(( (PRAZO + 5) * 1000 ))

titulo "F7 - resposta tardia" "latência de $((LATENCIA_MS / 1000)) s, maior que o prazo de ${PRAZO} s: cancela no prazo, depois estorna"
login_operador
./scripts/reset-estoque.sh >/dev/null
antes=$(disponivel)

echo "Passo 1: gateway com latência de $((LATENCIA_MS / 1000)) s"
gateway_ajustar "$LATENCIA_MS" 0

echo "Passo 2: cria um pedido"
id=$(criar_pedido_cliente)
echo "         pedido #$id criado"

echo "Passo 3: no prazo (${PRAZO} s) o pedido deve virar CANCELADO"
esperar_status "$id" CANCELADO $((PRAZO + 8))
verificar "status no prazo" CANCELADO "$(status_pedido "$id")"
verificar "motivo" PRAZO_EXPIRADO "$(motivo_pedido "$id")"
esperar_ate "[ \"\$(disponivel)\" = \"$antes\" ]" 10
verificar "unidade devolvida" "$antes" "$(disponivel)"

echo "Passo 4: a aprovação atrasada chega e o pagamento é estornado (até $((LATENCIA_MS / 1000 + 20)) s)"
esperar_status "$id" ESTORNADO $((LATENCIA_MS / 1000 + 20))

echo
echo "Resultado:"
verificar "status final" ESTORNADO "$(status_pedido "$id")"
verificar "pagamento no banco" ESTORNADO "$(sql pagamento "SELECT status FROM pagamentos WHERE pedido_id = $id")"
verificar "estornos no gateway" 1 "$(gateway_cobrancas | grep -o "\"estornos\":.*" | grep -o "\"pedidoId\":$id" | wc -l | tr -d ' ')"
verificar "unidade continua devolvida" "$antes" "$(disponivel)"
echo
echo "Histórico do pedido:"
api GET "/api/pedidos/$id/historico" | grep -o '"para":"[A-Z_]*"' | sed 's/"para":/   -> /'

finalizar F7 "Grafana, na linha «F7 · Resposta tardia»: \"Por prazo\" e \"Estornados\" subiram e o registro mostra o prazo vencido e o estorno. Em cima, na tabela, clique no pedido \"Estornado\": o caminho mostra o gateway demorando e, depois, o estorno."