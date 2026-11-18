#!/usr/bin/env bash
# Bônus (infraestrutura como código): o Terraform destrói e recria, ao vivo, os segredos, o bucket, a tabela do
# DynamoDB e a topologia do RabbitMQ (exchanges, filas, DLQs e bindings). Nada é criado à mão.
# Ao apagar uma fila o broker cancela os consumidores: depois do apply, os serviços são reiniciados para reassinar.
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1

var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }

# Soma dos consumidores nas filas de entrada dos quatro serviços
consumidores() {
  curl -s -u "$(var RABBITMQ_USUARIO):$(var RABBITMQ_SENHA)" "http://127.0.0.1:15672/api/queues?columns=name,consumers" \
    | sed -E 's/\},\{/\n/g; s/[][{}"]//g' \
    | grep -E "name:(pedidos|estoque|pagamento|entregas)\.entrada(,|$)" \
    | sed -nE 's/.*consumers:([0-9]+).*/\1/p' \
    | awk '{ s += $1 } END { print s + 0 }'
}

mostrar_filas() {
  ./scripts/estado.sh 2>/dev/null | sed -n '/== Filas do RabbitMQ/,/== Pedidos por status/p' | grep -v -e '^$' -e '== Pedidos'
}

echo "=== Antes (estado atual)"
mostrar_filas
echo "   consumidores nas filas de entrada: $(consumidores)"

echo
echo "=== terraform destroy: apaga segredos, bucket, tabela e topologia"
docker compose run --rm -e INFRA_ACAO=destroy infra 2>&1 | grep -E "Destroy complete|Error"

echo
echo "=== Durante: o RabbitMQ sem filas (e o MiniStack sem segredos)"
mostrar_filas

echo
echo "=== terraform apply: recria tudo do zero"
docker compose run --rm infra 2>&1 | grep -E "Apply complete|Error"

echo
echo "=== Os consumidores perderam as filas apagadas: reinicia os serviços para reassinar (as conexões voltam sozinhas, as assinaturas não)"
docker compose restart pedidos estoque pagamento entregas >/dev/null 2>&1
# o serviço do CQRS (profile bonus), se estiver no ar, também perdeu a fila dele
[ -n "$(docker compose --profile bonus ps -q consultas 2>/dev/null)" ] && docker compose --profile bonus restart consultas >/dev/null 2>&1
echo "   esperando os consumidores voltarem (até 90 s)"
esperado=$(( 3 + $(var PAGAMENTO_REPLICAS) ))   # pedidos, estoque, entregas e as réplicas do pagamento
for i in $(seq 1 45); do
  n=$(consumidores)
  [ "$n" -ge "$esperado" ] && break
  sleep 2
done
echo "   consumidores nas filas de entrada: $n (esperado: $esperado)"

echo
echo "=== Depois"
mostrar_filas
./scripts/estado.sh 2>/dev/null | sed -n '/== Segredos/,$p' | grep -v '^$'

echo
echo "Serviços:"
docker compose ps --format 'table {{.Service}}\t{{.Status}}' | grep -E "pedidos|estoque|pagamento|entregas"

if [ "$n" -ge "$esperado" ]; then echo; echo "IaC: PASSOU (tudo recriado do zero e os consumidores voltaram)"; else echo; echo "IaC: FALHOU (os consumidores não voltaram: $n de $esperado)"; exit 1; fi
