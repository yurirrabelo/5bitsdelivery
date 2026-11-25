#!/usr/bin/env bash
# F1: gateway falhando 100% -> pagamento recusado -> pedido CANCELADO -> unidade devolvida ao estoque.
source "$(dirname "$0")/lib.sh"
trap restaurar EXIT

titulo "F1 - compensação" "gateway com 100% de falha: o pedido deve ser cancelado e a unidade devolvida"
login_operador
./scripts/reset-estoque.sh >/dev/null
antes=$(disponivel)

echo "Passo 1: gateway passa a falhar em 100% das cobranças"
gateway_ajustar 0 100

echo "Passo 2: cria um pedido"
id=$(criar_pedido_cliente)
echo "         pedido #$id criado"

echo "Passo 3: espera a compensação (até 30 s)"
esperar_status "$id" CANCELADO 30

echo
echo "Resultado:"
verificar "status do pedido" CANCELADO "$(status_pedido "$id")"
verificar "motivo (o cliente vê 'pagamento recusado')" PAGAMENTO_RECUSADO "$(motivo_pedido "$id")"
esperar_ate "[ \"\$(disponivel)\" = \"$antes\" ]" 15
verificar "unidade devolvida (disponíveis)" "$antes" "$(disponivel)"
verificar "unidades reservadas" 0 "$(estoque_campo reservado)"
verificar "pagamento no banco" RECUSADO "$(sql pagamento "SELECT status FROM pagamentos WHERE pedido_id = $id")"
echo
echo "Histórico do pedido (para ver no trace: reservar -> recusado -> cancelado):"
api GET "/api/pedidos/$id/historico" | grep -o '"para":"[A-Z_]*"' | sed 's/"para":/   -> /'

finalizar F1 "Grafana: \"Sem sucesso\" subiu 1. Na tabela \"Pedidos recentes\", clique no pedido recusado: o caminho dele mostra o erro em vermelho e o estoque devolvendo a unidade."
