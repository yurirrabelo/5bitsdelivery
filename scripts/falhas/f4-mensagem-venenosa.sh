#!/usr/bin/env bash
# F4: uma mensagem com payload inválido em estoque.reservar. Três tentativas e depois a DLQ.
# Os pedidos normais, feitos em paralelo, seguem sem ser afetados.
source "$(dirname "$0")/lib.sh"
DLQ="$(var FILA_ESTOQUE).dlq"
# A mensagem venenosa FICA na DLQ depois do teste, para dar tempo de mostrar no Grafana e no RabbitMQ.
# Quem a esvazia é o próximo F4 (mais abaixo) ou o ./demo.sh limpar.
devolver_ao_normal() { repor_estoque; restaurar; }
trap devolver_ao_normal EXIT

titulo "F4 - mensagem venenosa" "payload inválido: 3 tentativas e depois ${DLQ}; os outros pedidos seguem"
login_operador
repor_estoque
rabbit_api DELETE "/api/queues/%2F/$DLQ/contents" >/dev/null   # começa com a DLQ vazia
esperar_ate "[ \"\$(fila_prontas $DLQ)\" = 0 ]" 20               # o número da API de gestão atrasa uns segundos depois de esvaziar
inicio=$(date -u +%Y-%m-%dT%H:%M:%SZ)
primeiro=$(( $(maior_pedido) + 1 ))

echo "Passo 1: publica a mensagem venenosa (pedidoId não numérico) e, em paralelo, 3 pedidos normais"
publicar_mensagem estoque.reservar "$(uuid)" '{"pedidoId":"isto-nao-e-um-numero"}'
for i in 1 2 3; do criar_pedido_cliente >/dev/null; done

echo "Passo 2: espera a mensagem chegar à DLQ (até 30 s)"
esperar_ate "[ \"\$(fila_prontas $DLQ)\" = 1 ]" 30
esperar_ate "[ \"\$(contar_pedidos \"id >= $primeiro AND status = 'CONFIRMADO'\")\" = 3 ]" 30

echo
echo "Resultado:"
verificar "mensagens na DLQ ${DLQ}" 1 "$(fila_prontas "$DLQ")"
tentativas=$(docker compose logs --since "$inicio" estoque 2>&1 | grep -c "erro na mensagem estoque.reservar")
verificar "tentativas registradas no log (MAX_TENTATIVAS)" "$(var MAX_TENTATIVAS)" "$tentativas"
verificar "pedidos normais CONFIRMADOS" 3 "$(contar_pedidos "id >= $primeiro AND status = 'CONFIRMADO'")"
verificar "fila principal sem mensagem parada" 0 "$(fila_prontas "$(var FILA_ESTOQUE)")"
echo
echo "Conteúdo da DLQ (para mostrar no painel do RabbitMQ: http://localhost:15672):"
rabbit_api POST "/api/queues/%2F/$DLQ/get" '{"count":1,"ackmode":"ack_requeue_true","encoding":"auto"}' | grep -o '"payload":"[^}]*}' | head -1 | cut -c1-200

finalizar F4 "Grafana, na linha «F4 · Mensagem venenosa»: \"Na DLQ\" = 1, \"Erros\" = 3 e o registro mostra as 3 tentativas. No RabbitMQ (http://localhost:15672) a fila ${DLQ} guarda o conteúdo da mensagem. Ela fica lá até o próximo F4 ou ./demo.sh limpar."