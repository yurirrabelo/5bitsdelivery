#!/usr/bin/env bash
# Funções comuns dos cenários de falha (F1 a F8). Use com:  source "$(dirname "$0")/lib.sh"
# Cada cenário provoca a falha, espera, compara o esperado com o obtido e termina com PASSOU ou FALHOU.
# Ao sair, devolve a configuração normal (gateway sem latência nem falha, serviços no ar).

# Git Bash (Windows) converte caminhos como /carga/x.js em C:/Program Files/...: desliga isso
export MSYS_NO_PATHCONV=1

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ" || exit 1

var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
BASE="http://localhost:$(var NGINX_PORTA)"
FALHAS=0
TOKEN=""

# ---------------------------------------------------------------- JSON simples (sem depender de jq)
campo() { # campo '<json>' nome  -> valor de um campo (texto ou número)
  echo "$1" | grep -o "\"$2\":[^,}]*" | head -1 | sed -E 's/^"[^"]*":"?//; s/"$//'
}

# ---------------------------------------------------------------- API
login_operador() {
  local r
  r=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$(var OPERADOR_USUARIO)\",\"password\":\"$(var OPERADOR_SENHA)\"}")
  TOKEN=$(campo "$r" token)
  [ -n "$TOKEN" ] || { echo "Não consegui entrar como operador. O sistema está no ar? (docker compose ps)"; exit 2; }
}

api() { # api METODO caminho [corpo]
  if [ -n "${3:-}" ]; then
    curl -s -X "$1" "$BASE$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$3"
  else
    curl -s -X "$1" "$BASE$2" -H "Authorization: Bearer $TOKEN"
  fi
}

# O entregador aceita um pedido (como no celular): espera o pedido aparecer na lista dele e toca em Aceitar.
token_entregador() { # token_entregador 1|2
  campo "$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$(var ENTREGADOR${1}_USUARIO)\",\"password\":\"$(var ENTREGADOR${1}_SENHA)\"}")" token
}
aceitar_entrega() { # aceitar_entrega entregador pedido  -> escreve o HTTP do aceite (200 = aceito)
  local t; t=$(token_entregador "$1")
  esperar_ate "curl -s '$BASE/api/entregas/me' -H 'Authorization: Bearer $t' | grep -q '\"pedidoId\":$2'" 40 || { echo 0; return; }
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/entregas/$2/aceitar" -H "Authorization: Bearer $t"
}

criar_pedido() { # cria um pedido do operador (com destino) e escreve o id
  local r
  r=$(api POST /api/pedidos '{"destino":{"lat":-26.9100,"lon":-49.0700,"endereco":"Destino do teste"}}')
  campo "$r" id
}

status_pedido() { campo "$(api GET "/api/pedidos/$1")" status; }
motivo_pedido() { campo "$(api GET "/api/pedidos/$1")" motivo; }
disponivel() { campo "$(api GET /api/estoque)" disponivel; }
estoque_campo() { campo "$(api GET /api/estoque)" "$1"; }
# Os 30 itens são dois grupos: 10 com cupom (produto 2) e 20 normais (produto 1). As funções acima falam do item todo (a soma).
estoque_cupom() { sql estoque "SELECT $1 FROM estoque WHERE produto_id = 2"; } # estoque_cupom disponivel|reservado|vendido|total

# ---------------------------------------------------------------- espera
esperar_status() { # esperar_status id status segundos
  local fim=$((SECONDS + $3))
  while [ $SECONDS -lt $fim ]; do
    [ "$(status_pedido "$1")" = "$2" ] && return 0
    sleep 0.5
  done
  return 1
}

esperar_ate() { # esperar_ate "comando" segundos  (espera o comando devolver sucesso)
  local fim=$((SECONDS + $2))
  while [ $SECONDS -lt $fim ]; do
    eval "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------- bancos, filas, gateway
sql() { # sql servico "consulta"  -> resultado simples (sem cabeçalho)
  docker compose exec -T "pg-$1" psql -U "$1" -d "$1" -Atc "$2" 2>/dev/null | tr -d '\r'
}

gateway_cobrancas() { docker compose exec -T gateway-pagamento wget -qO- http://127.0.0.1:3000/cobrancas 2>/dev/null; }

esperar_saudavel() { # esperar_saudavel servico segundos
  esperar_ate "[ \"\$(docker compose ps --format '{{.Health}}' $1 | grep -vc healthy)\" = 0 ] && [ -n \"\$(docker compose ps -q $1)\" ]" "$2"
}

# Sobrescreve o .env só para este cenário. As variáveis ficam EXPORTADAS: qualquer outro "docker compose up"
# do cenário reavalia o gateway (é dependência do pagamento) e, sem elas, voltaria ao valor do .env.
gateway_ajustar() { # gateway_ajustar latencia_ms taxa_falha
  export GATEWAY_LATENCIA_MS="$1" GATEWAY_TAXA_FALHA="$2"
  docker compose up -d --force-recreate gateway-pagamento >/dev/null 2>&1
  esperar_saudavel gateway-pagamento 60
}

restaurar() { # volta à configuração normal (valores do .env)
  echo
  echo "Restaurando a configuração normal..."
  unset GATEWAY_LATENCIA_MS GATEWAY_TAXA_FALHA
  docker compose up -d --force-recreate gateway-pagamento >/dev/null 2>&1
  docker compose up -d pagamento pedidos estoque rabbitmq >/dev/null 2>&1
}

# ---------------------------------------------------------------- RabbitMQ (API de gestão, só em 127.0.0.1)
rabbit_api() { # rabbit_api METODO caminho [corpo]
  curl -s -u "$(var RABBITMQ_USUARIO):$(var RABBITMQ_SENHA)" -X "$1" -H 'Content-Type: application/json' \
    ${3:+-d "$3"} "http://127.0.0.1:15672$2"
}

fila_prontas() { # fila_prontas nome  -> mensagens prontas (sem as não confirmadas)
  local v
  for _ in 1 2 3 4 5; do # logo depois de muita atividade a API de gestão pode demorar a trazer o número (já veio vazio uma vez)
    v=$(campo "$(rabbit_api GET "/api/queues/%2F/$1")" messages_ready)
    [ -n "$v" ] && { echo "$v"; return; }
    sleep 1
  done
}

uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || python -c 'import uuid;print(uuid.uuid4())'; }

# Publica um envelope na exchange com a routing key = type. Para testar mensagens duplicadas e venenosas.
publicar_mensagem() { # publicar_mensagem type messageId payload_json
  local env corpo
  env="{\"messageId\":\"$2\",\"correlationId\":\"$(uuid)\",\"type\":\"$1\",\"version\":1,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"payload\":$3}"
  corpo=$(printf '{"properties":{"message_id":"%s","content_type":"application/json","delivery_mode":2},"routing_key":"%s","payload":%s,"payload_encoding":"string"}' \
    "$2" "$1" "$(printf '%s' "$env" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")
  rabbit_api POST "/api/exchanges/%2F/$(var RABBITMQ_EXCHANGE)/publish" "$corpo" >/dev/null
}

# ---------------------------------------------------------------- clientes do QR e carga
criar_pedido_cliente() { # sessão nova de cliente + pedido do item (termina em CONFIRMADO, sem entrega). Escreve o id.
  local t r
  t=$(campo "$(curl -s -X POST "$BASE/api/auth/cliente" -H 'Content-Type: application/json' \
    -d "{\"apelido\":\"teste$RANDOM\",\"codigo\":\"$(var EVENTO_CODIGO)\"}")" token)
  r=$(curl -s -X POST "$BASE/api/pedidos" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d '{}')
  campo "$r" id
}

maior_pedido() { sql pedidos "SELECT coalesce(max(id), 0) FROM pedidos"; }
contar_pedidos() { # contar_pedidos "id > 10 AND status = 'CONFIRMADO'"
  sql pedidos "SELECT count(*) FROM pedidos WHERE $1"
}
outbox_pendentes() { sql "$1" "SELECT count(*) FROM outbox WHERE publicada_em IS NULL"; }

repor_estoque() { ./scripts/reset-estoque.sh "$@" >/dev/null; }

# Cenários que usam entregas partem de um estado limpo: conclui as entregas em andamento (libera os entregadores)
# e apaga as que ficaram esperando entregador. Só para os testes: não use no dia da apresentação.
limpar_entregas_de_teste() {
  # primeiro as que esperam entregador (senão, ao liberar um entregador, uma delas o ocuparia de novo)
  sql entregas "DELETE FROM entregas WHERE status = 'PENDENTE'" >/dev/null
  for p in $(sql entregas "SELECT pedido_id FROM entregas WHERE status = 'ATRIBUIDA'"); do
    api POST "/api/entregas/$p/confirmar" >/dev/null
  done
  esperar_ate "[ \"\$(sql entregas \"SELECT count(*) FROM entregadores WHERE status = 'OCUPADO'\")\" = 0 ]" 20
}

# Roda um script do k6 e devolve a linha RESUMO {...}. Segundo argumento: variáveis extras (-e NOME=valor ...).
k6() { # k6 script.js [-e VAR=valor ...]
  local s="$1"; shift
  docker compose --profile carga run --rm "$@" k6 run "/carga/$s" 2>&1
}
resumo_k6() { echo "$1" | grep -o 'RESUMO {.*}' | tail -1 | sed 's/^RESUMO //'; }

# ---------------------------------------------------------------- relatório
# Todo cenário começa do zero: sem pedidos de testes anteriores, estoque cheio, entregadores livres e sem posição de GPS
# (os pontos que ficaram no mapa). O que o cenário provoca fica no banco até o próximo começar, para dar tempo de mostrar.
zerar_banco() {
  echo "Passo 0: zera o banco para começar do zero"
  ./scripts/limpar.sh >/dev/null 2>&1 || { echo "  [ERRO] não consegui zerar o banco"; FALHAS=$((FALHAS + 1)); }
}

titulo() { echo; echo "=== $1"; echo "    $2"; echo; zerar_banco; }

verificar() { # verificar "o que" esperado obtido
  if [ "$2" = "$3" ]; then
    printf '  [OK]   %-52s esperado=%s obtido=%s\n' "$1" "$2" "$3"
  else
    printf '  [ERRO] %-52s esperado=%s obtido=%s\n' "$1" "$2" "$3"
    FALHAS=$((FALHAS + 1))
  fi
}

finalizar() { # finalizar "F1" ["o que mostrar agora no Grafana"]
  echo
  if [ "$FALHAS" -eq 0 ]; then
    echo "$1: PASSOU"
    [ -n "${2:-}" ] && echo "Mostre agora: $2"
    return 0
  fi
  echo "$1: FALHOU ($FALHAS verificação(ões) com erro)"
  return 1
}
