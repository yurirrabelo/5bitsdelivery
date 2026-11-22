#!/usr/bin/env bash
# F5: 100 clientes pedem ao mesmo tempo as 10 unidades da promoção (k6). Nenhuma unidade é vendida duas vezes:
# exatamente 10 CONFIRMADO e 90 ESGOTADO, com a invariante do estoque intacta.
source "$(dirname "$0")/lib.sh"
trap 'repor_estoque; restaurar' EXIT

QTD=$(var PROMOCAO_QUANTIDADE)
CLIENTES=100
titulo "F5 - corrida pelo recurso escasso" "${CLIENTES} clientes simultâneos para ${QTD} unidades: ${QTD} CONFIRMADO e $((CLIENTES - QTD)) ESGOTADO"
login_operador
repor_estoque "$QTD"
primeiro=$(( $(maior_pedido) + 1 ))

echo "Passo 1: k6 com ${CLIENTES} clientes, cada um com a própria sessão, largando juntos"
saida=$(k6 f5-corrida.js -e "CLIENTES=$CLIENTES")
echo "$saida" | grep -E "checks|pedido aceito|sess" | head -4
echo "         resumo do k6: $(resumo_k6 "$saida")"

echo "Passo 2: espera os pedidos terminarem"
esperar_ate "[ \"\$(contar_pedidos \"id >= $primeiro AND status IN ('RECEBIDO','AGUARDANDO_PAGAMENTO')\")\" = 0 ]" 40

echo
echo "Resultado:"
verificar "pedidos criados" "$CLIENTES" "$(contar_pedidos "id >= $primeiro")"
verificar "CONFIRMADO" "$QTD" "$(contar_pedidos "id >= $primeiro AND status = 'CONFIRMADO'")"
verificar "ESGOTADO" "$((CLIENTES - QTD))" "$(contar_pedidos "id >= $primeiro AND status = 'ESGOTADO'")"
verificar "unidades disponíveis no fim" 0 "$(disponivel)"
verificar "unidades vendidas" "$QTD" "$(estoque_campo vendido)"
verificar "reservas ativas (sem venda dupla)" "$QTD" "$(sql estoque "SELECT count(*) FROM reservas WHERE status IN ('RESERVADA','CONFIRMADA')")"
inv=$(sql estoque "SELECT (disponivel + reservado + vendido = total AND disponivel >= 0)::text FROM estoque WHERE produto_id = 1")
verificar "invariante: disponivel + reservado + vendido = total e disponivel >= 0" true "$inv"

finalizar F5 "Grafana → Apresentação: \"Unidades restantes\" zerou e \"Sem sucesso\" subiu. Escolha um 😕 Esgotado: a arquitetura do pedido mostra o Estoque em vermelho."
