# 5Bits Delivery: passo a passo do zero

Siga na ordem. Cada passo diz o que fazer e como saber que deu certo. Se algo falhar, vá à seção **Se der problema**, no fim.

> **Não entendeu uma tela?** Abra o [GUIA_DAS_TELAS.md](docs/GUIA_DAS_TELAS.md): explica cada site e cada painel do Grafana.
> **Vai apresentar?** O roteiro está em [material-apoio/ROTEIRO_APRESENTACAO.md](material-apoio/ROTEIRO_APRESENTACAO.md).

## Todas as senhas são `admin`

| Onde | Usuário | Senha |
|---|---|---|
| Painel do operador | `admin` | `admin` |
| App do entregador (celular) | `entregador1` | `admin` |
| Código do QR / link do cliente | (sem usuário) | `promo` |
| Grafana | abre direto, sem login (para editar: `admin`) | `admin` |
| RabbitMQ (opcional, não precisa abrir) | `admin` | `admin` |

---

## Parte 1: colocar no ar (no notebook)

**1. Instale** o **Docker Desktop** (aberto, com 6 GB de memória em Settings → Resources) e o **Git** (no Windows ele traz o **Git Bash**).

**2. Abra o Git Bash** na pasta do projeto:

```bash
cd /c/code/TrabalhoFinalSistemasDistribuidos
```

**3. Crie a configuração** (os valores de exemplo já funcionam):

```bash
cp .env.example .env
```

**4. Suba tudo.** A primeira vez leva de 5 a 10 minutos; depois, menos de 1:

```bash
docker compose up -d --build
```

**5. Confira.** Todos devem ficar `healthy` (o `infra` aparece `Exited (0)`: é normal). Se algum estiver `starting`, espere 1 minuto e rode de novo:

```bash
docker compose ps
```

**6. Abra no navegador:**

| O que | Endereço |
|---|---|
| Painel do operador | http://localhost:8080 |
| Grafana (a tela da apresentação) | http://localhost:3000 |

No painel você vê o mapa, o estoque (10 unidades) e embaixo "mapa ao vivo conectado".

---

## Parte 2: ver funcionando (sem celular)

**7. Teste completo automático.** Deixe o painel aberto e rode:

```bash
./scripts/smoke-test.sh
```

O marcador 🛵 anda no mapa. No fim: **`SMOKE: PASSOU`**.

**8. Faça um pedido como cliente.** Abra (de preferência em outra aba):

```
http://localhost:8080/cliente/?codigo=promo
```

Entra sozinho. Toque em **Quero um pedido!** e veja: recebido → unidade reservada → pagando → confirmado.

**9. Veja o pedido no Grafana** (http://localhost:3000). Na tabela **"Pedidos recentes"**, clique no número do pedido: ao lado aparece o caminho dele por cada serviço, com o tempo de cada um. Espere uns 20 segundos depois do pedido: é o tempo do Grafana indexar.

**10. (Opcional) Testes automáticos e falhas do professor**, um script por vez:

```bash
./scripts/test-all.sh                       # ~3 min, termina com TESTES: PASSOU
./scripts/falhas/f1-compensacao.sh          # pagamento falha: pedido cancelado, unidade volta
./scripts/falhas/f2-servico-morre.sh        # mata uma réplica: a outra assume
./scripts/falhas/f3-mensagem-duplicada.sh   # mesma mensagem 5 vezes: um efeito só
./scripts/falhas/f4-mensagem-venenosa.sh    # mensagem inválida: vai para a DLQ
./scripts/falhas/f5-corrida.sh              # 100 clientes para 10 unidades
./scripts/falhas/f6-broker-fora.sh          # RabbitMQ fora por 30 s
./scripts/falhas/f7-resposta-tardia.sh      # aprovação depois do prazo: estorno
./scripts/falhas/f8-escala.sh               # 3 réplicas dividindo a carga
./scripts/falhas/todos.sh                   # todos (~14 min)
```

Rode **um de cada vez**: dois juntos atrapalham um ao outro. Para ver o estado a qualquer hora: `./scripts/estado.sh`.

---

## Parte 3: celular e moto (dia da apresentação)

Ensaio completo: [material-apoio/ROTEIRO_ENSAIO.md](material-apoio/ROTEIRO_ENSAIO.md).

**11. Ajuste o `.env`:** coordenadas da faculdade (`ORIGEM_LAT`, `ORIGEM_LON`) e um texto longo e aleatório em `ENTREGADOR1_DEVICE_ID` (é a "senha" do GPS). Para uma apresentação pública, troque também as senhas e o `EVENTO_CODIGO`. Aplique:

```bash
docker compose up -d
```

**12. Ligue o túnel** e anote a URL `https://….trycloudflare.com` (não reinicie o túnel depois):

```bash
docker compose --profile tunnel up -d
./scripts/tunnel-url.sh
```

**13. No notebook,** abra o painel **pela URL do túnel**: `https://SUA-URL/painel/`, entre com `admin` / `admin`. O QR code agora aponta para a URL pública.

**14. No celular do entregador** (dados móveis, sem Wi-Fi): abra `https://SUA-URL/entregador/`, entre como `entregador1` / `admin`, menu do Chrome → **Instalar app**, toque em **Disponível**.

**15. No Traccar Client** (gratuito), preencha e ligue o serviço:

| Campo | Valor |
|---|---|
| Server URL | `https://SUA-URL/gps` |
| Device identifier | o `ENTREGADOR1_DEVICE_ID` do `.env` |
| Location accuracy / Interval | High / 3 s |

No Android, libere o Traccar para rodar **sem restrição de bateria**. Em poucos segundos o 🛵 aparece no painel.

**16. (Opcional) Aviso no Telegram:** fale com o **@BotFather** (`/newbot`), o entregador manda `/start` ao bot, pegue o `chat.id` em `https://api.telegram.org/bot<TOKEN>/getUpdates` e preencha no `.env` `NOTIFICACAO_PROVIDER=telegram`, `TELEGRAM_BOT_TOKEN` e `ENTREGADOR1_TELEGRAM_CHAT_ID`. Aplique com `docker compose up -d`. Sem Telegram, o aviso aparece em `docker compose logs entregas`.

**17. Faça um pedido de verdade:** no painel, clique no mapa onde o entregador deve ir → escolha o entregador → **Criar pedido**. O celular avisa, o marcador anda e, a menos de 50 m do destino, vira **`ENTREGUE`**.

**18. Antes de começar a apresentar**, reponha as 10 unidades:

```bash
./scripts/reset-estoque.sh
```

---

## Desligar

| Quero | Comando |
|---|---|
| Parar e **guardar** os dados | `docker compose down` |
| Parar e **apagar tudo** (recomeçar do zero) | `docker compose down -v` |
| Ver o log de um serviço | `docker compose logs -f pedidos` |

---

## Se der problema

| Sintoma | O que fazer |
|---|---|
| `docker compose` não funciona | abra o Docker Desktop e espere ficar "running" |
| Serviço `unhealthy` ou reiniciando | dê 6 GB ao Docker e rode `docker compose up -d` de novo |
| Porta 8080 ou 3000 ocupada | mude `NGINX_PORTA` no `.env` ou feche o programa que usa a porta |
| Erro com `\r` num `.sh` | `git config --global core.autocrlf input` e clone de novo |
| `.sh` não abre no Windows | use o **Git Bash**, não o PowerShell |
| Pedido fica em `CONFIRMADO` | nenhum entregador `Disponível`: veja `./scripts/estado.sh` |
| Pedidos caem em `ESGOTADO` | `./scripts/reset-estoque.sh` |
| Grafana sem o caminho do pedido | espere ~20 s e aumente o período no canto superior direito |
| Marcador não aparece | confira Server URL e Device identifier do Traccar; `docker compose logs -f entregas` |
| App do entregador não instala | abra pela URL `https://` do túnel |
| Troquei a senha de um banco ou do RabbitMQ no `.env` e deu erro | essas senhas ficam gravadas nos volumes: `docker compose down -v` e suba de novo |

Mais detalhes: [README.md](README.md).
