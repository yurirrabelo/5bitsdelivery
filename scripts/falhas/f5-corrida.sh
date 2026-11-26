#!/usr/bin/env bash
# F5: 100 clientes pedem ao mesmo tempo, com o cupom, os 10 itens com cupom (k6). Nenhum item é vendido duas vezes:
# exatamente 10 CONFIRMADO e 90 ESGOTADO, com a invariante do estoque intacta e os 20 itens normais sem ninguém tocar.
source "$(dirname "$0")/lib.sh"
trap 'repor_estoque; restaurar' EXIT

QTD=$(var PROMOCAO_QUANTIDADE)
NORMAIS=$(( $(var ITEM_QUANTIDADE) - QTD ))
CLIENTES=100
titulo "F5 - corrida pelo recurso escasso" "${CLIENTES} clientes simultâneos, todos com o cupom, para ${QTD} itens com cupom: ${QTD} CONFIRMADO e $((CLIENTES - QTD)) ESGOTADO"
login_operador
repor_estoque
primeiro=$(( $(maior_pedido) + 1 ))

echo "Passo 1: k6 com ${CLIENTES} clientes, cada um com a própria sessão e o cupom, largando juntos"
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
verificar "itens com cupom disponíveis no fim" 0 "$(estoque_cupom disponivel)"
verificar "itens com cupom vendidos" "$QTD" "$(estoque_cupom vendido)"
verificar "reservas ativas (sem venda dupla)" "$QTD" "$(sql estoque "SELECT count(*) FROM reservas WHERE status IN ('RESERVADA','CONFIRMADA')")"
verificar "itens normais intactos" "$NORMAIS" "$(sql estoque "SELECT disponivel FROM estoque WHERE produto_id = 1")"
inv=$(sql estoque "SELECT bool_and(disponivel + reservado + vendido = total AND disponivel >= 0)::text FROM estoque")
verificar "invariante: disponivel + reservado + vendido = total e disponivel >= 0" true "$inv"

finalizar F5 "Grafana, na linha «F5 · Corrida pelo estoque»: \"Confirmados\" e \"Esgotados\" somam os 100 pedidos (10 e 90) e o gráfico dos itens com cupom chega a 0 e não passa disso."
