#!/usr/bin/env bash
# Funções comuns dos cenários de falha (F1 a F8). Use com:  source "$(dirname "$0")/lib.sh"
# Cada cenário provoca a falha, espera, compara o esperado com o obtido e termina com PASSOU ou FALHOU.
# Ao sair, devolve a configuração normal (gateway sem latência nem falha, serviços no ar).

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

criar_pedido() { # cria um pedido do operador (com destino) e escreve o id
  local r
  r=$(api POST /api/pedidos '{"destino":{"lat":-26.9100,"lon":-49.0700,"endereco":"Destino do teste"}}')
  campo "$r" id
}

status_pedido() { campo "$(api GET "/api/pedidos/$1")" status; }
motivo_pedido() { campo "$(api GET "/api/pedidos/$1")" motivo; }
disponivel() { campo "$(api GET /api/estoque)" disponivel; }
estoque_campo() { campo "$(api GET /api/estoque)" "$1"; }

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

# ---------------------------------------------------------------- relatório
titulo() { echo; echo "=== $1"; echo "    $2"; echo; }

verificar() { # verificar "o que" esperado obtido
  if [ "$2" = "$3" ]; then
    printf '  [OK]   %-52s esperado=%s obtido=%s\n' "$1" "$2" "$3"
  else
    printf '  [ERRO] %-52s esperado=%s obtido=%s\n' "$1" "$2" "$3"
    FALHAS=$((FALHAS + 1))
  fi
}

finalizar() { # finalizar "F1"
  echo
  if [ "$FALHAS" -eq 0 ]; then
    echo "$1: PASSOU"
    return 0
  fi
  echo "$1: FALHOU ($FALHAS verificação(ões) com erro)"
  return 1
}
