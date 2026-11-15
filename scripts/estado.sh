#!/usr/bin/env bash
# Mostra o estado do sistema: containers, filas do RabbitMQ, segredos e bucket.
cd "$(dirname "$0")/.."
# Lê só as variáveis necessárias (o .env tem valores com espaço, então não dá para usar "source")
var() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
RABBITMQ_USUARIO=$(var RABBITMQ_USUARIO); RABBITMQ_SENHA=$(var RABBITMQ_SENHA)
AWS_ACCESS_KEY_ID=$(var AWS_ACCESS_KEY_ID); AWS_REGION=$(var AWS_REGION)

echo "== Containers"
docker compose ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

echo
echo "== Filas do RabbitMQ"
printf '%-28s %8s %8s %12s\n' fila prontas naoconf consumidores
curl -s -u "$RABBITMQ_USUARIO:$RABBITMQ_SENHA" \
  "http://127.0.0.1:15672/api/queues?columns=name,messages_ready,messages_unacknowledged,consumers" \
  | sed -E 's/\},\{/\n/g; s/[][{}"]//g' \
  | while IFS= read -r l || [ -n "$l" ]; do
      nome=$(echo "$l" | sed -nE 's/.*name:([^,]+).*/\1/p')
      pronta=$(echo "$l" | sed -nE 's/.*messages_ready:([0-9]+).*/\1/p')
      naoconf=$(echo "$l" | sed -nE 's/.*messages_unacknowledged:([0-9]+).*/\1/p')
      cons=$(echo "$l" | sed -nE 's/.*consumers:([0-9]+).*/\1/p')
      printf '%-28s %8s %8s %12s\n' "$nome" "${pronta:-0}" "${naoconf:-0}" "${cons:-0}"
    done | sort

echo
echo "== Segredos (Secrets Manager no MiniStack)"
curl -s -X POST "http://127.0.0.1:4566/" \
  -H "Content-Type: application/x-amz-json-1.1" -H "X-Amz-Target: secretsmanager.ListSecrets" \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=$AWS_ACCESS_KEY_ID/20260101/$AWS_REGION/secretsmanager/aws4_request, SignedHeaders=host, Signature=x" \
  -d '{}' | grep -Eo '"Name": *"[^"]+"' | sed -E 's/"Name": *//' | sort

echo
echo "== Bucket S3"
curl -s "http://127.0.0.1:4566/" \
  -H "Authorization: AWS4-HMAC-SHA256 Credential=$AWS_ACCESS_KEY_ID/20260101/$AWS_REGION/s3/aws4_request, SignedHeaders=host, Signature=x" \
  | grep -Eo '<Name>[^<]+</Name>' | sed -E 's/<\/?Name>//g'
