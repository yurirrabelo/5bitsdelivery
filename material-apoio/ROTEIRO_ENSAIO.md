# Roteiro do ensaio com a moto

Objetivo: fazer o percurso real do pedido até `ENTREGUE`, conferir as peças que só funcionam com o celular de verdade (Traccar, PWA, Telegram, túnel) e deixar a rota gravada para o plano B. Faça com o notebook que vai ser usado na apresentação.

Tudo aqui foi verificado com o simulador; **o que depende do celular e da moto ainda não foi testado**. É para isso que serve o ensaio.

## 1. Preparar o `.env` (30 min, em casa)

Edite o `.env` (nunca commite) e troque os valores de exemplo:

| Variável | O que colocar |
|---|---|
| `ORIGEM_LAT`, `ORIGEM_LON`, `ORIGEM_NOME` | coordenadas da faculdade (clique com o botão direito no Google Maps e copie) |
| `ENTREGADOR1_DEVICE_ID` | um texto longo e aleatório (é o "token" do Traccar) |
| `EVENTO_CODIGO` | um código novo (vai no QR) |
| `OPERADOR_SENHA`, `ENTREGADOR1_SENHA` | pode deixar `admin` (usuários `admin` e `entregador1`); troque só se o túnel ficar aberto fora da apresentação |
| `NOTIFICACAO_PROVIDER`, `TELEGRAM_BOT_TOKEN`, `ENTREGADOR1_TELEGRAM_CHAT_ID` | `telegram` e os dados do bot (passos no README) |

Depois: `docker compose up -d --build` e `docker compose ps` (tudo `healthy`; o `infra` termina com 0). Mudou o `.env`? O mesmo comando recria só o que mudou.

## 2. Túnel e celular (20 min)

- [ ] `docker compose --profile tunnel up -d` e `./scripts/tunnel-url.sh` → anote a URL `https://….trycloudflare.com`.
- [ ] **Teste no 4G do celular, com o Wi-Fi desligado.** Abra `https://<url>/entregador/` e entre como `entregador1`.
- [ ] No Chrome: menu → **Instalar app**. Abra pelo ícone e confirme que entra sem barra do navegador. O botão **Disponível** deve ficar ativo.
- [ ] Traccar Client: `Server URL = https://<url>/gps`, `Device identifier = ENTREGADOR1_DEVICE_ID`, High, 3 s / 0 m, heartbeat 30 s. Android: Traccar sem restrição de bateria. Ligue o serviço.
- [ ] No notebook: painel em `https://<url>/painel/` (pela URL do túnel). O marcador 🛵 do colega aparece em poucos segundos e a barra de baixo mostra "última posição há X s".
- [ ] A opção **Enviar localização pelo app** fica **desligada** (uma fonte por vez).
- [ ] Hora do celular em automático (o servidor ignora posições com horário atrasado em relação à última).

Se o marcador não aparecer: `docker compose logs -f entregas` (device id errado dá `401` no `/gps`).

## 3. O percurso (o ensaio em si)

- [ ] `./scripts/reset-estoque.sh` e `./scripts/estado.sh` (colega `DISPONIVEL`, nenhuma entrega aberta).
- [ ] Destino a **5–8 min da faculdade**, em frente a um endereço onde a moto possa parar a menos de 50 m (o geofence é `GEOFENCE_RAIO_M=50`).
- [ ] No painel: clique no destino, escolha o colega em *Entregador* e **Criar pedido**. Esperado: `202`, o pedido passa por `AGUARDANDO_PAGAMENTO` → `CONFIRMADO` → `EM_ENTREGA` em poucos segundos.
- [ ] O Telegram chega com o link do Google Maps. Quem pilota **não mexe no celular andando**: lê o pedido antes de sair e usa o suporte.
- [ ] Anote o pedido (ex.: `#12`) e conduza até o destino. No painel o marcador anda e o rastro (laranja) cresce.
- [ ] Chegando, o geofence marca `ENTREGUE` sozinho e o Telegram avisa "✅ Pedido #12 entregue.". Se não marcar em 20 s parado no destino, use **Confirmar entrega** no app (e anote a distância mostrada).

## 4. Gravar o plano B (5 min)

A rota fica no S3 alguns segundos depois da entrega (laço de 10 s). Troque `12` pelo número do pedido:

```bash
curl -s http://127.0.0.1:4566/delivery-rotas/rotas/pedido-12.geojson > simulador/rotas/ensaio.geojson
```

Teste o plano B uma vez, com o Traccar do colega **pausado**, num pedido novo para o colega (ou para o simulado, `ENTREGADOR2_DEVICE_ID`):

```bash
docker compose --profile sim run --rm simulador rota \
  --arquivo /rotas/ensaio.geojson --device <ENTREGADOR1_DEVICE_ID> --velocidade 40
```

(o caminho é `/rotas/...`, o de dentro do container). No telão a reprodução é idêntica a uma posição real. Depois: `./scripts/reset-estoque.sh`.

## 5. Os cenários de falha (20 min, sem o celular)

- [ ] `./scripts/falhas/todos.sh` no notebook da apresentação: tudo `PASSOU` (uns 14 min). **Rode um só por vez**: dois ao mesmo tempo falham por interferência.
- [ ] Rede da faculdade: o túnel sai pela porta 7844. Teste lá; se bloquear, use o roteador do celular no notebook.

## O que anotar

| Medida | Valor |
|---|---|
| "Última posição há X s" típico na moto | |
| Pedido criado → `EM_ENTREGA` (s) | |
| Telegram chegou? Em quantos segundos | |
| Geofence concluiu sozinho? Distância final (m) | |
| Quantos pontos tem a rota gravada | |
| Plano B funcionou? | |

## Se algo der errado

| Sintoma | Causa provável | Ação |
|---|---|---|
| Painel não abre pela URL do túnel | túnel reiniciou (a URL muda) | `./scripts/tunnel-url.sh` e refazer Traccar e PWA; **não reinicie o `cloudflared` no dia** |
| `/gps` devolve 401 | `ENTREGADOR1_DEVICE_ID` diferente do Traccar | conferir os dois |
| Marcador não anda | Traccar parado ou bateria restrita | abrir o Traccar; `docker compose logs -f entregas` |
| Pedido fica em `CONFIRMADO` | colega não está `DISPONIVEL` | status no app; `./scripts/estado.sh` |
| Colega "em entrega" sem entrega real | sobrou entrega de teste | conclua pelo botão **Confirmar entrega** |
| Telegram não chega | bot sem `/start` ou chat id errado | `docker compose logs entregas` mostra a mensagem |
| PWA não instala | página sem HTTPS | abrir pela URL do túnel |
