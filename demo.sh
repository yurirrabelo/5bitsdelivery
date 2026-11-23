#!/usr/bin/env bash
# Atalhos para tudo o que a demonstração precisa. No Windows, rode pelo Git Bash.
#
#   ./demo.sh subir        sobe o sistema inteiro, liga a aba Testes do painel de gestão e espera ficar pronto
#   ./demo.sh link         liga o túnel HTTPS e mostra os links para o celular (obrigatório para o GPS do celular)
#   ./demo.sh reset [N]    repõe as unidades da promoção (padrão: o valor do .env)
#   ./demo.sh limpar [N]   começa limpo, sem reiniciar (o link do túnel não muda): apaga os pedidos e as entregas de teste, repõe as unidades e libera os entregadores
#   ./demo.sh teste        fluxo completo: o cliente pede, o entregador 2 aceita e "dirige" (termina com SMOKE: PASSOU)
#   ./demo.sh unitarios    testes do código das bibliotecas e serviços, em containers (~3 min)
#   ./demo.sh simular [1|2] [km/h]   plano B do GPS: aceita o pedido que está esperando e reproduz a rota do ensaio (padrão: entregador 2)
#   ./demo.sh falha [N]    cenário de falha do professor: 1 a 8 (ou 6b), ou "todas"; sem número, mostra a lista e pergunta
#   ./demo.sh testes       liga (se preciso) e abre a tela de testes: os mesmos botões da aba Testes do painel de gestão (http://localhost:8099)
#   ./demo.sh estado       containers, filas, pedidos, estoque e segredos
#   ./demo.sh parar        para tudo e guarda os dados
#   ./demo.sh apagar       para tudo e apaga os dados (recomeço do zero)
#
# Cada atalho só chama o comando de sempre (docker compose ... ou um script de scripts/): nada novo acontece aqui.
cd "$(dirname "$0")" || exit 1
export MSYS_NO_PATHCONV=1

var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }

uso() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

achar_python() { # no Windows, "python3" pode ser só o atalho da Loja: confere se roda de verdade
  PY=""
  for c in python3 python py; do
    if "$c" -c "import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)" >/dev/null 2>&1; then PY="$c"; return 0; fi
  done
  return 1
}

# A aba Testes do painel de gestão fala com uma tela local (scripts/testes), que roda os cenários de falha. Liga em segundo
# plano; sem Python, a aba avisa como ligar. Ela só atende páginas de localhost: o painel aberto pelo link público não a alcança.
TESTES_URL=http://localhost:8099
testes_ligada() { curl -s -o /dev/null --max-time 2 "$TESTES_URL/api/cenarios"; }
iniciar_testes() {
  testes_ligada && return 0
  achar_python || return 0
  TESTES_ABRIR=0 nohup "$PY" scripts/testes/servidor.py >/dev/null 2>&1 &
}
parar_testes() { curl -s -o /dev/null --max-time 2 -X POST -H 'Content-Type: application/json' "$TESTES_URL/api/encerrar"; }

menu_falhas() {
  cat <<'MENU'
Cenários de falha do professor (rode um de cada vez; cada um leva até uns 3 minutos):

  1    Compensação           o pagamento é recusado e o sistema desfaz tudo
  2    Serviço morre         uma réplica do pagamento morre no meio do trabalho e a outra assume
  3    Mensagem duplicada    a mesma mensagem chega 5 vezes e vale uma vez só
  4    Mensagem venenosa     uma mensagem inválida vai para a DLQ sem travar as outras
  5    Corrida pelo estoque  100 clientes disputam 10 unidades: vendem exatamente 10
  6    Broker fora           o RabbitMQ cai por 30 s e volta: nada se perde
  6b   MiniStack (nuvem) fora o S3 cai durante uma entrega: a rota sai quando ele volta
  7    Resposta tardia       o pagamento demora mais que o prazo: cancela no prazo e estorna depois
  8    Escala                3 réplicas do pagamento dividem a carga, sem cobrança duplicada
  todas                      todos em sequência (uns 14 min, só para ensaiar)

MENU
}

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
    echo "  Entrada:             http://localhost:$P            (admin ou entregador1, senha admin)"
    echo "  Painel de gestão:    http://localhost:$P/painel/"
    echo "  Pedidos (QR):        http://localhost:$P/cliente/?codigo=$(var EVENTO_CODIGO)"
    echo "  Grafana:             http://localhost:3000"
    echo "Para usar o celular como entregador (GPS real): ./demo.sh link"
    iniciar_testes
    echo "Testes de falha do professor: aba Testes do painel de gestão (abra por http://localhost:$P/painel/)"
    ;;
  link)
    docker compose --profile tunnel up -d cloudflared || exit 1
    echo "Esperando o túnel..."
    URL=$(./scripts/tunnel-url.sh) || exit 1
    echo
    echo "Entrada (qualquer um entra e vai para a sua tela):  $URL/"
    echo "Painel de gestão (notebook):     $URL/painel/                    (admin / admin)"
    echo "Entregador (celular):            $URL/entregador/                (entregador1 / admin)"
    echo "Pedidos (QR da plateia):         $URL/cliente/?codigo=$(var EVENTO_CODIGO)"
    echo
    echo "Não reinicie o túnel depois: a URL muda a cada reinício."
    ;;
  reset) shift; ./scripts/reset-estoque.sh "$@" ;;
  limpar) shift; ./scripts/limpar.sh "$@" ;;
  teste) shift; ./scripts/smoke-test.sh "$@" ;;
  unitarios) ./scripts/test-all.sh ;;
  simular)
    # a rota gravada no ensaio (simulador/rotas/ensaio.geojson) ou, se não houver, a de exemplo
    ROTA=/rotas/ensaio.geojson; [ -f simulador/rotas/ensaio.geojson ] || ROTA=/rotas/exemplo.geojson
    docker compose --profile sim run --rm --build simulador rota --arquivo "$ROTA" --entregador "${2:-2}" --velocidade "${3:-40}" ;;
  falha)
    N="${2:-}"
    if [ -z "$N" ]; then
      menu_falhas
      [ -t 0 ] || exit 2 # sem terminal para perguntar: só mostra a lista
      read -r -p "Qual o número do cenário? (Enter para sair) " N
      [ -n "$N" ] || exit 0
    fi
    case "$N" in
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
      *) menu_falhas; exit 2 ;;
    esac
    ;;
  testes)
    achar_python || { echo "A tela de testes precisa do Python 3. Sem ele, use: ./demo.sh falha N"; exit 1; }
    if testes_ligada; then
      echo "A tela de testes já está ligada: $TESTES_URL (os mesmos botões estão na aba Testes do painel de gestão)."
      "$PY" -c "import webbrowser; webbrowser.open('$TESTES_URL')"
    else
      exec "$PY" scripts/testes/servidor.py
    fi ;;
  estado) ./scripts/estado.sh ;;
  parar) parar_testes; docker compose --profile '*' down ;;
  apagar) parar_testes; docker compose --profile '*' down -v ;;
  -h|--help|help) uso 0 ;;
  *) uso 2 ;;
esac
