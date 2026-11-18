# Roteiro da apresentação (5 pessoas, ~20 min)

Ideia: quatro pessoas apresentam e fazem a demonstração; a quinta, o entregador, **chega na sala com o pedido** como grande final e explica o GPS. Depois a plateia pede pelo QR code e vê os traces nascerem no Grafana.

Dúvida sobre uma tela? [GUIA_DAS_TELAS.md](GUIA_DAS_TELAS.md). Como subir tudo: [README](../README.md).

## Quem faz o quê

| Pessoa | Papel | Fala sobre |
|---|---|---|
| **1** | Abertura | o problema (promoção relâmpago, muita gente pedindo, nada pode ser vendido a mais) e o **C4 nível 1** (cliente, operador, entregador, operadora de pagamento) |
| **2** | Arquitetura | **C4 nível 2**: os 6 serviços, em que linguagem, e o que é "nuvem" (tabela abaixo) |
| **3** | Comunicação | REST na borda, RabbitMQ entre os serviços, saga do pedido, outbox/inbox, DLQ, o que acontece quando algo falha |
| **4** | Demonstração | cria o pedido, conduz o Grafana, chama o grande final e depois abre o QR code |
| **5** | Entregador | espera fora da sala com o celular; chega no momento combinado; explica o GPS |

### O que a pessoa 2 mostra (cada coisa onde roda)

| O quê | Quantos | Onde roda |
|---|---|---|
| Serviços de negócio: **pedidos**, **estoque** (Java), **pagamento** (2 réplicas), **entregas**, **auth** (TypeScript) | 5 (6 containers) | aplicação, em containers |
| **Gateway de pagamento** (faz o papel da operadora externa) | 1 | aplicação, mas tratado como sistema de fora |
| **RabbitMQ**, **Postgres** (um por serviço), **Redis** | 1 + 4 + 1 | infraestrutura, em containers |
| **Secrets Manager** (senhas e chave do JWT) e **S3** (rota GPS de cada entrega) | 2 | **nuvem** (AWS, simulada localmente pelo MiniStack e criada por Terraform) |
| **Grafana, Tempo, Prometheus, Loki** | 1 | observabilidade |
| **Navegador do celular** (GPS) e **Cloudflare Tunnel** (https) | | celular e rede |

**Justificativas que o professor pede** (a pessoa 2 responde, em uma frase cada; o texto completo está em [ESPECIFICACAO.md](ESPECIFICACAO.md), seção 3.3):

| Escolha | Por que ela, e não a alternativa |
|---|---|
| **RabbitMQ** (broker) | roteia por tipo de mensagem (exchange topic), tem consumidores concorrentes, fila quorum que conta as tentativas e manda para a DLQ, painel e métricas prontas. SQS + SNS exigiriam um tópico e filas por tipo; o Kafka é pesado e feito para log de eventos |
| **Secrets Manager** | é feito para segredo; variável de ambiente aparece no `docker inspect` e nos logs, e o SSM Parameter Store é para configuração |
| **S3** | a rota GPS é um arquivo: não pertence ao banco transacional e o disco do container some com ele |
| **Java + TypeScript** | Java onde a transação é o assunto (pedidos e estoque: `@Transactional` deixa inbox, efeito e outbox na mesma transação); TypeScript onde há I/O (pagamento em réplicas, GPS e WebSocket) |

Como se comunicam (pessoa 3): o cliente fala com o sistema por **HTTP (REST)**; os serviços falam entre si por **mensagens no RabbitMQ** (assíncrono, sem esperar um pelo outro); o gateway de pagamento é chamado por **HTTP**; o GPS chega por **HTTP** (o navegador do celular envia) e o mapa recebe por **WebSocket**.

## Linha do tempo

| Quando | Quem | O que acontece |
|---|---|---|
| 0:00 | 1 | Abertura e C4 nível 1 |
| 2:00 | 2 | C4 nível 2: serviços, onde roda cada um |
| 5:00 | 3 | Comunicação, saga, outbox/inbox, DLQ |
| 8:00 | 4 | **Pedido de verdade.** No painel: clica no destino (a porta da sala) → escolhe *Entregador Real* → **Criar pedido**. Mostra o `202` na hora e o pedido andando. **Lá fora o celular do colega avisa** (tela, vibração e som) e ele começa a vir |
| 9:00 | 4 | Grafana: abre o pedido na tabela "O caminho do pedido" (pedidos → estoque → pagamento → gateway → entregas, com o tempo de cada um). O marcador 🛵 vem andando no mapa do painel |
| 12:00 | 4 | "Alguém pediu um pedido?" **A pessoa 5 entra na sala.** O sistema marca **ENTREGUE** sozinho (menos de 50 m do destino) ou ele toca em **Confirmar entrega** |
| 13:00 | 5 | Explica o GPS: o navegador do celular manda a posição a cada 3 s → túnel → serviço de entregas → Redis → WebSocket → mapa. Fala da latência do 4G |
| 15:00 | 4 | **QR code.** Repõe o estoque e abre o telão com o QR. Um botão só: **Quero um pedido!** |
| 15:30 | 2 | Narra o Grafana enquanto a plateia pede: pessoas que entraram, pedidos por minuto, tempo do pagamento, "Unidades restantes" caindo, o mapa de serviços |
| 18:00 | todos | Quando as unidades acabam: **"Sem sucesso"** sobe sem o estoque ficar negativo. É o cenário F5 acontecendo ao vivo |
| 19:00 | todos | Perguntas. Se o professor pedir uma falha (F1 a F8): `./demo.sh falha N` e mostre no **Detalhes técnicos** |

Se a apresentação for mais curta, corte o C4 nível 1 e a falha extra. O que não se corta: o pedido, a chegada e o QR.

## Dicas que fazem diferença

1. **Crie o pedido cedo, não no fim.** O colega precisa de tempo para chegar. Crie o pedido quando a pessoa 3 estiver terminando (8:00) e deixe o marcador vir andando enquanto a pessoa 4 mostra o Grafana.
2. **Defina o destino na porta da sala, mas confie no botão.** O GPS dentro de prédio erra 10 a 30 m. A conclusão automática vale a menos de 50 m (e só com precisão melhor que 100 m). Se não disparar, o colega toca em **Confirmar entrega**: fica igualmente bom na plateia.
3. **O colega espera a 200 m ou mais** (outro corredor ou prédio), para o marcador *andar* de verdade antes de chegar. Se ficar perto demais, o pedido vira `ENTREGUE` antes da hora.
4. **Estoque diferente para cada momento.** Com 10 unidades, o pedido principal usa 1 e sobram 9. Antes do QR, rode `./demo.sh reset 25`: 25 unidades fazem uma turma de 40 pessoas ver sucesso para a maioria e "acabaram" para o resto, o que mostra que o sistema não vende além do estoque.
5. **O QR em tela cheia, com a URL em texto embaixo** (alguns celulares não leem o QR da tela). Use o **Modo telão** do painel.
6. **Grafana em tela cheia no telão** com o endereço `http://localhost:3000/d/apresentacao/apresentacao?kiosk`. Mostre o painel do operador e o Grafana em duas abas, e troque entre elas.
7. **Quem narra o Grafana não é quem opera.** A pessoa 4 mexe nas telas e a pessoa 2 explica o que aparece.
8. **Mostre o vermelho de propósito.** Com a turma pedindo, ligue uma taxa de falha no gateway (`GATEWAY_TAXA_FALHA=30 docker compose up -d gateway-pagamento`). Cerca de 3 em cada 10 pedidos passam a ser recusados: a tabela mostra "Recusado", o caminho do pedido mostra em vermelho onde falhou e o mapa de serviços ganha um anel vermelho no pagamento. Depois volte: `docker compose up -d gateway-pagamento`. Ensaie isso: é a parte que mais impressiona.
9. **Plano B pronto e ensaiado** (veja "Ensaio"): se o GPS real falhar, o simulador reproduz a rota do ensaio e a plateia não percebe a diferença (`./demo.sh simular`).

## Antes de começar (30 min antes)

- [ ] Notebook na tomada. `./demo.sh subir` e `./demo.sh link`; `docker compose ps` com tudo `healthy`. **Não reinicie o túnel daqui para frente.**
- [ ] Abra o painel **pelo link do túnel** (assim o QR aponta para o endereço público).
- [ ] `./demo.sh reset` (10 unidades) e o gateway sem falha e sem atraso (`GATEWAY_TAXA_FALHA=0`, `GATEWAY_LATENCIA_MS=0` no `.env`).
- [ ] Colega com a página do entregador aberta no celular, **Disponível**, cartão "GPS enviando" verde, e o marcador aparecendo no painel com "última posição há X s" baixo.
- [ ] Pedido de teste até `EM_ENTREGA`: o celular avisou? Conclua pelo botão. Depois `./demo.sh reset` de novo.
- [ ] Faça um pedido pelo QR para conferir: aparece no Grafana (espere ~20 s).
- [ ] Abas: painel (link do túnel), Grafana (Apresentação), um terminal na pasta do projeto.
- [ ] Combinem o sinal para o colega entrar e uma mensagem de "fecha a página" para o plano B.

## Ensaio com o celular (até 25/11)

Faça com o notebook que vai ser usado na apresentação. Tudo foi testado com o simulador; **o que depende do celular e da moto só se confirma aqui**.

1. **Preparar (em casa).** No `.env`: `ORIGEM_LAT`, `ORIGEM_LON` e `ORIGEM_NOME` da faculdade; troque `EVENTO_CODIGO` se o túnel ficar aberto fora da apresentação. Depois `./demo.sh subir` e `./demo.sh link`.
2. **Celular, no 4G com o Wi-Fi desligado.** Abra `https://<url>/entregador/`, entre como `entregador1`, toque em **Disponível** e permita a localização. O cartão do GPS deve ficar verde ("GPS enviando, precisão de X m"). Se não: o cartão diz o que falta (https, permissão ou sinal).
3. **Notebook.** Painel em `https://<url>/painel/`: o 🛵 do colega aparece em poucos segundos e a barra de baixo mostra "última posição há X s".
4. **O percurso.** `./demo.sh reset`; destino a 5–8 min da faculdade, onde a moto pare a menos de 50 m. No painel: clique no destino → *Entregador Real* → **Criar pedido**. Esperado: `202`, o pedido passa por `AGUARDANDO_PAGAMENTO` → `CONFIRMADO` → `EM_ENTREGA` em poucos segundos e o celular avisa. Conduza até o destino: no painel o marcador anda e o rastro laranja cresce. Chegando, vira `ENTREGUE` sozinho; se não virar em 20 s parado no destino, **Confirmar entrega** (anote a distância mostrada).
5. **Gravar o plano B** (5 min). A rota fica no S3 alguns segundos depois da entrega. Troque `12` pelo número do pedido:

   ```bash
   curl -s http://127.0.0.1:4566/delivery-rotas/rotas/pedido-12.geojson > simulador/rotas/ensaio.geojson
   ```

   Teste o plano B uma vez, com a página do celular **fechada** (para só uma fonte enviar o GPS), num pedido novo para o colega:

   ```bash
   ./demo.sh simular 1 40      # entregador 1, 40 km/h; usa simulador/rotas/ensaio.geojson (ou a rota de exemplo)
   ```

   No telão a reprodução é idêntica a uma posição real. Depois: `./demo.sh reset`.
6. **Falhas, sem o celular** (20 min): `./demo.sh falha todas` no notebook da apresentação: tudo `PASSOU` (uns 14 min). **Um cenário por vez**: dois ao mesmo tempo falham por interferência.
7. **Rede da faculdade.** O túnel sai pela porta 7844. Teste lá; se bloquear, use o roteador do celular no notebook. Teste também o QR com a turma de verdade (ou uns 20 celulares), no Wi-Fi e no 4G.

| O que anotar | Valor |
|---|---|
| "Última posição há X s" típico na moto | |
| Pedido criado → `EM_ENTREGA` (s) | |
| O celular avisou? Em quantos segundos | |
| Geofence concluiu sozinho? Distância final (m) | |
| Quantos pontos tem a rota gravada | |
| Plano B funcionou? | |

## Se algo der errado

| Problema | Faça |
|---|---|
| Pedido principal não chega a `EM_ENTREGA` | conferir se o colega está **Disponível** (celular) e criar outro pedido escolhendo-o |
| Marcador parado por mais de 30 s | a tela do celular apagou ou a página saiu da frente: abrir de novo. Se não resolver, mandar "fecha a página" e rodar o plano B |
| O cartão do GPS está vermelho | "Abra o link https://": use o link do túnel. "Localização bloqueada": liberar nas configurações do navegador e tocar em **Tentar de novo** |
| A chegada não dispara sozinha | o colega toca em **Confirmar entrega** |
| Túnel ou rede caem antes de começar | roteador do celular no notebook; se não resolver, demonstração com o simulador e sem QR |
| Um serviço cai | `docker compose restart <serviço>` e use a favor: as mensagens esperaram na fila, nada se perdeu |
| A turma esgotou o estoque antes da hora | `./demo.sh reset 25` |
| O pedido não aparece na tabela do Grafana | espere ~20 s e confira o período (canto superior direito) |

**Segurança:** quem pilota não mexe no celular. O celular fica no suporte, com a página do entregador aberta e a tela ligada, e o pedido é lido antes de sair. Capacete e respeito ao trânsito: nenhuma demonstração vale um risco.
