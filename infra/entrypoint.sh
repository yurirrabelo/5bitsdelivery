#!/bin/sh
# Container "infra": espera MiniStack e RabbitMQ, aplica o Terraform e sai com 0.
set -eu

echo "[infra] esperando o MiniStack em ${AWS_ENDPOINT_URL}"
until wget -q -O /dev/null "${AWS_ENDPOINT_URL}/_ministack/health"; do sleep 2; done

echo "[infra] esperando a API de gestão do RabbitMQ"
AUTH=$(printf '%s:%s' "${TF_VAR_rabbitmq_usuario}" "${TF_VAR_rabbitmq_senha}" | base64 | tr -d '\n')
until wget -q -O /dev/null --header "Authorization: Basic ${AUTH}" \
  "${TF_VAR_rabbitmq_api_url}/api/overview"; do sleep 2; done

# Copia as fontes para um diretório gravável (o volume do repositório é somente leitura)
rm -rf /tmp/tf && cp -r /terraform /tmp/tf && cd /tmp/tf

terraform init -input=false -upgrade=false
terraform apply -input=false -auto-approve -state=/state/terraform.tfstate "$@"
echo "[infra] pronto"
