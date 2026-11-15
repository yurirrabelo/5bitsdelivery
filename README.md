# Delivery Tracker

Sistema de delivery com promoção relâmpago e rastreamento do entregador em tempo real, feito com microsserviços em Java e TypeScript, mensageria com RabbitMQ e serviços AWS emulados pelo MiniStack, tudo em Docker.

Trabalho final de Sistemas Distribuídos (FURB). Arquitetura, contratos, testes e decisões estão em [docs/ESPECIFICACAO.md](docs/ESPECIFICACAO.md).

![Containers (C4 nível 2)](docs/arquitetura/c4-containers.png)

## Visão rápida

| Serviço | Linguagem | Faz o quê |
|---|---|---|
| nginx | Nginx | entrada única, autenticação e páginas web |
| auth | TypeScript | login e JWT |
| pedidos | Java | API 202 e orquestração da saga |
| estoque | Java | unidades da promoção, sem venda dupla |
| pagamento | TypeScript | cobrança e estorno, com réplicas |
| entregas | TypeScript | despacho, GPS, mapa ao vivo e Telegram |
| gateway-pagamento | TypeScript | gateway externo simulado, lento e instável |

Infraestrutura: RabbitMQ, um Postgres por serviço, Redis, MiniStack (Secrets Manager e S3) criado por Terraform, e Grafana com métricas, logs e traces.

Bônus (profile `bonus`, desligados por padrão): `consultas` (CQRS com DynamoDB) e `autoscaler` (autoescala do pagamento). Veja a seção [Bônus](#bônus).

## Pré-requisitos

- Docker com Docker Compose v2 (no Windows e no macOS, o Docker Desktop). Reserve 6 GB de RAM para o Docker.
- Git. No Windows, rode os scripts `.sh` pelo Git Bash ou WSL.
- Para usar um celular como entregador: Android ou iPhone com o app **Traccar Client** e internet móvel. Telegram é opcional.

## Subindo o projeto

```bash
git clone <url-do-repositorio> delivery-tracker
cd delivery-tracker
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Espere todos os containers ficarem `healthy`; o `infra` (Terraform) roda uma vez e termina com código 0. Os serviços Java demoram mais na primeira vez.

Os valores do `.env.example` funcionam localmente. **Troque as senhas e o `EVENTO_CODIGO` antes de expor o sistema pelo túnel.**

## Endereços

| O quê | Onde |
|---|---|
| Painel do operador | http://localhost:8080 |
| App do entregador (PWA) | http://localhost:8080/entregador/ |
| Página do cliente (QR) | http://localhost:8080/cliente/ |
| Grafana (métricas, logs e traces) | http://localhost:3000 |
| RabbitMQ (filas e DLQs) | http://localhost:15672 (usuário e senha do `.env`) |
| MiniStack | http://localhost:4566 |

Usuários, com senhas no `.env`: `operador`, `entregador1` (o entregador real, no celular) e `entregador2` (simulado).

## Testando sem celular

```bash
./scripts/smoke-test.sh
```

Faz o fluxo completo com o entregador simulado: cria o pedido, reserva, paga, despacha, "dirige" até o destino e confere se terminou `ENTREGUE` com a rota no S3. Deixe o painel aberto para ver o marcador andando.

## Testes do professor (cenários F1 a F8)

```bash
./scripts/falhas/f1-compensacao.sh        # gateway falhando 100%: compensação
./scripts/falhas/f2-servico-morre.sh      # mata a réplica no meio do processamento
./scripts/falhas/f3-mensagem-duplicada.sh # mesma mensagem 5 vezes, um efeito
./scripts/falhas/f4-mensagem-venenosa.sh  # payload inválido: 3 tentativas e DLQ
./scripts/falhas/f5-corrida.sh            # 100 pedidos para 10 unidades
./scripts/falhas/f6-broker-fora.sh        # RabbitMQ fora por 30 s, com carga contínua
./scripts/falhas/f6b-ministack-fora.sh    # MiniStack fora durante uma entrega (S3)
./scripts/falhas/f7-resposta-tardia.sh    # aprovação depois do prazo: estorno
./scripts/falhas/f8-escala.sh             # 3 réplicas dividindo a carga
./scripts/falhas/todos.sh                 # todos em sequência
./scripts/estado.sh                       # estado dos bancos e das filas
```

Cada script mostra o esperado e o obtido e termina com **PASSOU** ou **FALHOU**, e devolve a configuração normal no final. Acompanhe no Grafana (painel "Delivery ao vivo", a página inicial) enquanto roda. O `todos.sh` leva uns 14 minutos.

F5 e F6 usam o k6 (`carga/`), que roda dentro do Docker, direto no Nginx:

```bash
docker compose --profile carga run --rm k6 run /carga/f5-corrida.js
docker compose --profile carga run --rm -e PEDIDOS_POR_MIN=60 -e DURACAO=60s k6 run /carga/carga-continua.js
```

Para mudar o gateway na hora, sem editar o `.env`:

```bash
GATEWAY_TAXA_FALHA=30 GATEWAY_LATENCIA_MS=2000 docker compose up -d gateway-pagamento
docker compose up -d gateway-pagamento   # volta ao que está no .env
```

## Emulador AWS (MiniStack)

O MiniStack é gratuito, não exige conta e roda num container só. Os serviços usam a API padrão da AWS pela variável `AWS_ENDPOINT_URL`, então o mesmo código roda numa AWS de verdade.

Segredos, bucket e a topologia do RabbitMQ são criados pelo Terraform (`infra/terraform/`). Para recriar tudo do zero:

```bash
./scripts/bonus/recriar-infra.sh
```

## Usando um celular como entregador

**1. Expor o sistema com HTTPS**

```bash
docker compose --profile tunnel up -d
./scripts/tunnel-url.sh
```

O script mostra algo como `https://palavras-aleatorias.trycloudflare.com`.

> A URL muda toda vez que o container `cloudflared` reinicia. Se mudar, refaça os passos 2 e 3.

**2. Instalar o app do entregador (PWA)**

No Chrome do celular, abra `https://<url-do-tunel>/entregador/`, entre como `entregador1` e use o menu **Instalar app**.

**3. Configurar o Traccar Client**

| Campo | Valor |
|---|---|
| Server URL | `https://<url-do-tunel>/gps` |
| Device identifier | valor de `ENTREGADOR1_DEVICE_ID` no `.env` |
| Location accuracy | High |
| Interval / Distance | 3 s / 0 m |
| Stationary heartbeat | 30 s |

Nas configurações do Android, libere o Traccar para rodar em segundo plano sem restrição de bateria. Depois, ligue o serviço no app.

**4. Conferir**

Em poucos segundos, o marcador do entregador aparece no painel. Se não aparecer, veja `docker compose logs -f entregas`.

## QR code para a turma

Abra o painel pela URL do túnel (ou cole a URL pública no campo do painel). O QR aponta para `https://<url-do-tunel>/cliente/?codigo=<EVENTO_CODIGO>`. Cada pessoa informa um apelido, faz um pedido da promoção e acompanha os passos no celular. O telão mostra só o número de cada pedido.

## Notificações no Telegram (opcional)

1. No Telegram, fale com o **@BotFather**, use `/newbot` e copie o token.
2. O entregador abre uma conversa com o bot e manda `/start`.
3. Abra `https://api.telegram.org/bot<TOKEN>/getUpdates` no navegador e copie o número em `message.chat.id`.
4. Preencha no `.env`:

   ```env
   NOTIFICACAO_PROVIDER=telegram
   TELEGRAM_BOT_TOKEN=<token>
   ENTREGADOR1_TELEGRAM_CHAT_ID=<chat id>
   ```

5. Rode `docker compose up -d` de novo; o Terraform atualiza o segredo e o Compose recria o que mudou.

Sem Telegram: use `NOTIFICACAO_PROVIDER=ntfy`, instale o app **ntfy** e assine o tópico de `NTFY_TOPICO`. Ou deixe `log` e veja as mensagens em `docker compose logs entregas`.

## Bônus

Cada bônus só vale se for demonstrado. Os dois serviços extras ficam no profile `bonus`:

| Bônus | Como demonstrar |
|---|---|
| Tracing distribuído | no Grafana, abra o trace de um pedido (Explore → Tempo): pedidos → estoque → pagamento → gateway → entregas |
| Infraestrutura como código | `./scripts/bonus/recriar-infra.sh`: `terraform destroy` e `apply` ao vivo (segredos, bucket, tabela e filas) |
| Versionamento de eventos | `./scripts/bonus/versionamento.sh`: `pedido.confirmado` v1 e v2 convivem; o estoque nunca foi alterado |
| CQRS | `docker compose --profile bonus up -d --build consultas`; leitura em `GET /api/consultas/pedidos/{id}` (DynamoDB) |
| Autoescala do consumidor | `./scripts/bonus/autoescala.sh` (sobe o `autoscaler`, gera carga e mostra as réplicas subindo e descendo) |

O painel e a página do cliente passam a ler da visão do CQRS quando o `consultas` está no ar e voltam para o `pedidos` quando não está.

## Comandos do dia a dia

```bash
docker compose logs -f pedidos              # logs de um serviço
docker compose up -d --scale pagamento=3    # mais réplicas do pagamento
docker compose restart estoque              # reinicia um serviço
./scripts/reset-estoque.sh                  # repõe as unidades da promoção
./scripts/test-all.sh                       # testes unitários e de integração, dentro de containers
./scripts/estado.sh                         # containers, filas, DLQs, pedidos, estoque e outbox
docker compose down                         # para tudo e mantém os dados
docker compose down -v                      # para tudo e apaga os dados
```

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `infra` termina com erro | MiniStack ou RabbitMQ ainda subindo, ou provider recusando o endpoint | `docker compose logs infra`; rode `docker compose up -d` de novo |
| Segredos ou bucket somem depois de parar o MiniStack | estado não persistido | confira `PERSIST_STATE=1` e o volume do `ministack` |
| Filas somem ao recriar o RabbitMQ | `hostname` diferente ou sem volume | mantenha `hostname: rabbitmq` e o volume |
| Containers caindo por falta de memória | Docker com pouca RAM | dê 6 GB ao Docker Desktop |
| Porta 8080 ou 3000 ocupada | outro programa usando | mude `NGINX_PORTA` no `.env` ou libere a porta |
| PWA não instala ou não pede localização | página aberta sem HTTPS | use a URL do túnel |
| Marcador não se mexe | Traccar parado, URL ou device id errados, economia de bateria | confira o app e `docker compose logs entregas` |
| Pedido do operador fica em `CONFIRMADO` | nenhum entregador disponível | confira o status do entregador no app ou escolha o entregador ao criar o pedido |
| Pedidos caindo em `ESGOTADO` | unidades da promoção acabaram | `./scripts/reset-estoque.sh` |
| Erro com `\r` em script `.sh` | final de linha do Windows | `git config --global core.autocrlf input` e clone de novo |
| `docker compose run ... /carga/x.js` falha no Git Bash com `C:/Program Files/Git/...` | o Git Bash converte caminhos | `export MSYS_NO_PATHCONV=1` (os scripts já fazem isso) |
| Telegram não chega | bot sem `/start` ou chat id errado | `docker compose logs entregas` |

## Estrutura

```
contracts/        AsyncAPI e JSON Schemas das mensagens
docs/             especificação, registro do tema e diagramas
nginx/            API Gateway
web/              painel, PWA do entregador, página do cliente e bibliotecas (Leaflet, QR code)
services/java/    pedidos e estoque (+ biblioteca commons)
services/ts/      auth, pagamento, gateway simulado, entregas, simulador (+ commons); bônus: consultas e autoscaler
infra/            Terraform (núcleo em main.tf, bônus em bonus.tf) e configuração do RabbitMQ
observabilidade/  Prometheus e painel "Delivery ao vivo" do Grafana
carga/            testes de carga (k6)
simulador/rotas/  rotas GeoJSON do simulador
scripts/          testes do professor (falhas/), bônus, túnel e utilitários
material-apoio/   prompt e roteiro da demonstração
```

## Equipe

| Integrante | Responsável por |
|---|---|
| | |
| | |
| | |
