# 5Bits Delivery: passo a passo do zero

Siga na ordem. Cada passo diz o que fazer e como saber que deu certo. Se algo der errado, vá direto à seção **Se der problema** no fim.

> Quer mais detalhe? O [README](README.md) explica cada parte. O ensaio com a moto está em [material-apoio/ROTEIRO_ENSAIO.md](material-apoio/ROTEIRO_ENSAIO.md) e a apresentação em [material-apoio/ROTEIRO_DEMO.md](material-apoio/ROTEIRO_DEMO.md).

---

## Parte 1: colocar o sistema no ar (no seu notebook)

### 1. Instale o que precisa
- **Docker Desktop** (aberto e rodando). Em Configurações → Resources, dê pelo menos **6 GB de memória**.
- **Git** (no Windows, ele traz o **Git Bash**).

### 2. Abra o terminal na pasta do projeto
No Windows, abra o **Git Bash**. Todos os comandos abaixo são para ele (ou para Linux/macOS).

```bash
cd /c/code/TrabalhoFinalSistemasDistribuidos
```

> Windows: antes de clonar o projeto em outra máquina, rode `git config --global core.autocrlf input`. Isso evita erro de final de linha nos scripts `.sh`.

### 3. Crie o arquivo de configuração
Use o comando:

```bash
cp .env.example .env
```

Pronto. Os valores de exemplo já funcionam na sua máquina. (Você só vai trocar algumas coisas na Parte 3, para a apresentação.)

### 4. Suba tudo
Use o comando:

```bash
docker compose up -d --build
```

A **primeira vez demora de 5 a 10 minutos** (ele baixa e constrói tudo). Das próximas vezes, leva menos de 1 minuto.

### 5. Confira se subiu
Use o comando:

```bash
docker compose ps
```

Esperado: todos os serviços com `healthy`. O `infra` aparece como `Exited (0)`: **isso é normal** (ele só cria os segredos e as filas e termina).

Se algum ainda estiver `starting`, espere 1 minuto e rode de novo (os serviços Java demoram mais).

### 6. Abra o navegador
Abra estes endereços:

| O que | Endereço | Usuário e senha |
|---|---|---|
| **Painel do operador** | http://localhost:8080 | `operador` / `dev-operador-123` |
| **Grafana** (métricas, logs e traces) | http://localhost:3000 | abre direto, sem login |
| **RabbitMQ** (filas) | http://localhost:15672 | `delivery` / `dev-rabbit-123` |

No painel você deve ver o mapa, o estoque (10 unidades) e, embaixo, "mapa ao vivo conectado".

---

## Parte 2: testar que tudo funciona (sem celular)

### 7. Faça o teste completo automático
Deixe o **painel aberto** no navegador e use o comando:

```bash
./scripts/smoke-test.sh
```

Ele cria um pedido, paga, despacha para o entregador simulado, "dirige" até o destino e confere o resultado. Olhe o painel: o marcador 🛵 anda no mapa. (Na primeira vez ele constrói a imagem do simulador, o que leva cerca de 1 minuto.)

Esperado no fim: **`SMOKE: PASSOU`**.

### 8. Faça um pedido como cliente
Abra no navegador (de preferência em outra aba):

```
http://localhost:8080/cliente/?codigo=troque-por-um-codigo
```

Digite um apelido, clique em **Entrar** e depois em **Pedir agora**. Você vê o pedido passando por: recebido → unidade reservada → pagando → confirmado.

### 9. Rode os testes automáticos
Use o comando (leva uns 3 minutos; não precisa de Java nem Node instalados):

```bash
./scripts/test-all.sh
```

Esperado no fim: **`TESTES: PASSOU`**.

### 10. Rode os cenários de falha do professor
Rode um de cada vez (cada um mostra o esperado e o obtido e termina com **PASSOU** ou **FALHOU**):

```bash
./scripts/falhas/f1-compensacao.sh        # pagamento falha: o pedido é cancelado e a unidade volta
./scripts/falhas/f2-servico-morre.sh      # mata uma réplica no meio: a outra assume
./scripts/falhas/f3-mensagem-duplicada.sh # mesma mensagem 5 vezes: um efeito só
./scripts/falhas/f4-mensagem-venenosa.sh  # mensagem inválida: vai para a DLQ
./scripts/falhas/f5-corrida.sh            # 100 clientes para 10 unidades
./scripts/falhas/f6-broker-fora.sh        # RabbitMQ fora por 30 s
./scripts/falhas/f7-resposta-tardia.sh    # aprovação depois do prazo: estorno
./scripts/falhas/f8-escala.sh             # 3 réplicas dividindo a carga
```

Ou todos de uma vez (uns 14 minutos):

```bash
./scripts/falhas/todos.sh
```

> **Importante:** rode **um script por vez**. Dois ao mesmo tempo atrapalham um ao outro.
> Enquanto roda, deixe o Grafana aberto (http://localhost:3000): ele mostra estoque, pagamentos, filas e o que acontece em cada falha.

### 11. Veja o estado do sistema quando quiser
Use o comando:

```bash
./scripts/estado.sh
```

Mostra containers, filas, pedidos por status, estoque e o que está esperando para ser enviado.

---

## Parte 3: usar com o celular e a moto (para a apresentação)

> Para ensaiar de verdade, use também o [roteiro do ensaio](material-apoio/ROTEIRO_ENSAIO.md).

### 12. Ajuste o `.env` para a apresentação
Abra o arquivo `.env` num editor e troque:

| Variável | Para quê |
|---|---|
| `ORIGEM_LAT` e `ORIGEM_LON` | coordenadas da faculdade (botão direito no Google Maps, copie) |
| `ENTREGADOR1_DEVICE_ID` | um texto longo e aleatório (é a "senha" do Traccar) |
| `EVENTO_CODIGO` | um código novo (vai dentro do QR code) |
| `OPERADOR_SENHA` e `ENTREGADOR1_SENHA` | senhas novas |

Depois aplique, com o comando:

```bash
docker compose up -d
```

### 13. Ligue o túnel (para o celular acessar o sistema)
Use os comandos:

```bash
docker compose --profile tunnel up -d
./scripts/tunnel-url.sh
```

O segundo comando mostra uma URL do tipo `https://palavras-aleatorias.trycloudflare.com`. **Anote essa URL.**

> A URL muda se o túnel reiniciar. Depois de configurada, **não reinicie o túnel**.

### 14. Configure a URL no painel
No notebook, abra o painel **pela URL do túnel** (e não por `localhost`):

```
https://SUA-URL.trycloudflare.com/painel/
```

Entre como `operador`. O QR code agora aponta para a URL pública, então a turma consegue pedir pelo celular.

### 15. Configure o celular do entregador
No Chrome do celular (com **dados móveis**, não precisa de Wi-Fi):

1. Abra `https://SUA-URL.trycloudflare.com/entregador/` e entre como `entregador1`.
2. Menu do Chrome → **Instalar app**.
3. Toque em **Disponível**.

### 16. Configure o Traccar Client (manda o GPS)
Instale o app **Traccar Client** (gratuito) e preencha:

| Campo | Valor |
|---|---|
| Server URL | `https://SUA-URL.trycloudflare.com/gps` |
| Device identifier | o valor de `ENTREGADOR1_DEVICE_ID` do seu `.env` |
| Location accuracy | High |
| Interval / Distance | 3 s / 0 m |
| Stationary heartbeat | 30 s |

No Android, libere o Traccar para rodar em segundo plano **sem restrição de bateria**. Ligue o serviço.

Esperado: em poucos segundos o marcador 🛵 aparece no painel e a barra de baixo mostra "última posição há X s".

### 17. (Opcional) Ligue o aviso no Telegram
1. No Telegram, fale com o **@BotFather**, mande `/newbot` e guarde o token.
2. O entregador abre uma conversa com o bot e manda `/start`.
3. Abra `https://api.telegram.org/bot<TOKEN>/getUpdates` no navegador e copie o número de `message.chat.id`.
4. No `.env`, preencha:
   ```
   NOTIFICACAO_PROVIDER=telegram
   TELEGRAM_BOT_TOKEN=<token>
   ENTREGADOR1_TELEGRAM_CHAT_ID=<chat id>
   ```
5. Aplique com `docker compose up -d`.

Sem Telegram, o aviso aparece no log: `docker compose logs entregas`.

### 18. Faça um pedido de verdade
No painel: clique no mapa onde o entregador deve ir → escolha o entregador → **Criar pedido**.

O pedido passa por `CONFIRMADO` → `EM_ENTREGA`, o celular recebe o aviso e o marcador anda no mapa. Ao chegar a menos de 50 m do destino, o sistema marca **`ENTREGUE`** sozinho (ou o entregador toca em **Confirmar entrega**).

### 19. Antes de começar a apresentação
Use o comando para repor as 10 unidades da promoção:

```bash
./scripts/reset-estoque.sh
```

---

## Parte 4: desligar

| Quero | Comando |
|---|---|
| Parar tudo e **guardar** os dados | `docker compose down` |
| Parar tudo e **apagar** os dados (recomeçar do zero) | `docker compose down -v` |
| Reiniciar só um serviço | `docker compose restart pedidos` |
| Ver o log de um serviço | `docker compose logs -f pedidos` |

---

## Se der problema

| Sintoma | O que fazer |
|---|---|
| `docker compose` não funciona | abra o Docker Desktop e espere ele ficar "running" |
| Serviço fica `unhealthy` ou reinicia | dê mais memória ao Docker (6 GB) e rode `docker compose up -d` de novo |
| Porta 8080 ou 3000 ocupada | mude `NGINX_PORTA` no `.env` ou feche o programa que usa a porta |
| Erro com `\r` num script `.sh` | rode `git config --global core.autocrlf input` e clone de novo |
| Um script `.sh` não abre no Windows | use o **Git Bash**, não o PowerShell |
| Pedidos ficam em `CONFIRMADO` e não saem | o entregador não está `Disponível`: veja `./scripts/estado.sh` |
| Pedidos caem em `ESGOTADO` | `./scripts/reset-estoque.sh` |
| O marcador não aparece | confira o Server URL e o Device identifier do Traccar; `docker compose logs -f entregas` |
| O app do entregador não instala | abra pela URL `https://` do túnel (precisa de HTTPS) |
| Rodei dois cenários juntos e deu erro | pare, rode `docker compose up -d` e rode **um por vez** |

Mais problemas e explicações: seção "Problemas comuns" do [README](README.md).

---

## Mapa dos documentos

| Documento | Para quê |
|---|---|
| **PASSO_A_PASSO.md** (este) | executar do zero, do jeito mais simples |
| [README.md](README.md) | manual completo: endereços, comandos, bônus, estrutura, problemas |
| [material-apoio/ROTEIRO_ENSAIO.md](material-apoio/ROTEIRO_ENSAIO.md) | ensaio com a moto, o celular e o plano B |
| [material-apoio/ROTEIRO_DEMO.md](material-apoio/ROTEIRO_DEMO.md) | roteiro da apresentação ao vivo |
| [docs/ESPECIFICACAO.md](docs/ESPECIFICACAO.md) | arquitetura, contratos e decisões |
