#!/usr/bin/env bash
# Atalhos para tudo o que a demonstração precisa. No Windows, rode pelo Git Bash.
#
#   ./demo.sh subir        sobe o sistema inteiro e espera ficar pronto
#   ./demo.sh link         liga o túnel HTTPS e mostra os links para o celular (obrigatório para o GPS do celular)
#   ./demo.sh reset [N]    repõe as unidades da promoção (padrão: o valor do .env)
#   ./demo.sh teste        fluxo completo com um entregador simulado (termina com SMOKE: PASSOU)
#   ./demo.sh unitarios    testes do código das bibliotecas e serviços, em containers (~3 min)
#   ./demo.sh simular [1|2] [km/h]   plano B do GPS: o simulador "dirige" a rota do ensaio como o entregador 1 (ou 2)
#   ./demo.sh falha N      cenário de falha do professor: 1 a 8 (ou 6b), ou "todas"
#   ./demo.sh estado       containers, filas, pedidos, estoque e segredos
#   ./demo.sh parar        para tudo e guarda os dados
#   ./demo.sh apagar       para tudo e apaga os dados (recomeço do zero)
#
# Cada atalho só chama o comando de sempre (docker compose ... ou um script de scripts/): nada novo acontece aqui.
cd "$(dirname "$0")" || exit 1
export MSYS_NO_PATHCONV=1

var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }

uso() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

esperar_pronto() { # espera todos os containers ficarem healthy (até 5 min)
  echo "Esperando os containers ficarem prontos (a primeira vez leva alguns minutos)..."
  for _ in $(seq 1 100); do
    if ! docker compose ps --format '{{.Health}}' | grep -qE 'starting|unhealthy' \
       && [ "$(docker compose ps --format '{{.Service}}' | grep -c .)" -ge 14 ]; then
      return 0
    fi
    sleep 3
  done
  echo "Ainda há containers subindo. Veja: docker compose ps"
  return 1
}

case "${1:-}" in
  subir)
    [ -f .env ] || { cp .env.example .env; echo "Criei o .env a partir do .env.example."; }
    docker compose up -d --build || exit 1
    esperar_pronto || true
    P=$(var NGINX_PORTA)
    echo
    echo "Pronto."
    echo "  Painel do operador:  http://localhost:$P            (admin / admin)"
    echo "  Cliente (QR):        http://localhost:$P/cliente/?codigo=$(var EVENTO_CODIGO)"
    echo "  Grafana:             http://localhost:3000"
    echo "Para usar o celular como entregador (GPS real): ./demo.sh link"
    ;;
  link)
    docker compose --profile tunnel up -d cloudflared || exit 1
    echo "Esperando o túnel..."
    URL=$(./scripts/tunnel-url.sh) || exit 1
    echo
    echo "Abra no navegador do notebook:   $URL/painel/                    (admin / admin)"
    echo "Abra no navegador do celular:    $URL/entregador/                (entregador1 / admin)"
    echo "QR da plateia (cliente):         $URL/cliente/?codigo=$(var EVENTO_CODIGO)"
    echo
    echo "Não reinicie o túnel depois: a URL muda a cada reinício."
    ;;
  reset) shift; ./scripts/reset-estoque.sh "$@" ;;
  teste) shift; ./scripts/smoke-test.sh "$@" ;;
  unitarios) ./scripts/test-all.sh ;;
  simular)
    # a rota gravada no ensaio (simulador/rotas/ensaio.geojson) ou, se não houver, a de exemplo
    ROTA=/rotas/ensaio.geojson; [ -f simulador/rotas/ensaio.geojson ] || ROTA=/rotas/exemplo.geojson
    docker compose --profile sim run --rm --build simulador rota --arquivo "$ROTA" --entregador "${2:-1}" --velocidade "${3:-40}" ;;
  falha)
    case "${2:-}" in
      1) exec ./scripts/falhas/f1-compensacao.sh ;;
      2) exec ./scripts/falhas/f2-servico-morre.sh ;;
      3) exec ./scripts/falhas/f3-mensagem-duplicada.sh ;;
      4) exec ./scripts/falhas/f4-mensagem-venenosa.sh ;;
      5) exec ./scripts/falhas/f5-corrida.sh ;;
      6) exec ./scripts/falhas/f6-broker-fora.sh ;;
      6b) exec ./scripts/falhas/f6b-ministack-fora.sh ;;
      7) exec ./scripts/falhas/f7-resposta-tardia.sh ;;
      8) exec ./scripts/falhas/f8-escala.sh ;;
      todas) exec ./scripts/falhas/todos.sh ;;
      *) echo "Use: ./demo.sh falha N   (N de 1 a 8, 6b ou todas)"; echo "  1 compensação · 2 serviço morre · 3 mensagem duplicada · 4 mensagem venenosa"; echo "  5 corrida pelo estoque · 6 broker fora · 7 resposta tardia · 8 escala"; exit 2 ;;
    esac
    ;;
  estado) ./scripts/estado.sh ;;
  parar) docker compose --profile '*' down ;;
  apagar) docker compose --profile '*' down -v ;;
  -h|--help|help) uso 0 ;;
  *) uso 2 ;;
esac
