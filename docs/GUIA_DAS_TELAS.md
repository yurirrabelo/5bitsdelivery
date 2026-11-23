# Guia das telas: o que cada site e cada painel mostra

Para quem não sabe o que está olhando. Começa pelo que é real e o que é simulado, depois cada site, depois cada painel do Grafana.

---

## 1. O que é real e o que é simulado

Tudo roda no seu notebook, mas **não é uma imitação do sistema**: são os mesmos serviços, bancos e filas que rodariam em produção, cada um no seu container.

| É de verdade | É simulado (e por quê) |
|---|---|
| Os 6 serviços (pedidos, estoque, pagamento, entregas, auth, gateway), em Java e TypeScript | O **gateway de pagamento**: é um serviço nosso que faz o papel de uma operadora externa. Dá para configurar falha e atraso (é assim que se provocam as falhas do professor) |
| RabbitMQ, os 4 bancos Postgres e o Redis | A **nuvem** (MiniStack): imita o Secrets Manager e o S3 da AWS (e o DynamoDB, no bônus), criados por Terraform |
| O GPS do celular: o navegador do entregador envia a posição real | A **ferramenta de teste** (`./demo.sh teste` e `./demo.sh simular`): faz o papel do celular no teste automático e como plano B do GPS |
| Os traces, métricas e logs: tudo que aparece no Grafana é medido, não inventado | |

**O que um notebook só não mostra:** latência de rede *entre* máquinas (aqui é quase zero). Os tempos que você vê no Grafana são o custo real de cada serviço trabalhar, sem a rede no meio. Em compensação, a **latência do GPS e do celular é real** (4G + túnel).

---

## 2. Cada site

| Endereço | Quem usa | Para que serve |
|---|---|---|
| **http://localhost:8080** (Entrada) | gestão e entregador | Um login só: quem é da gestão vai para o painel e quem é entregador vai para a tela do entregador. Mostra também os links das 3 interfaces (Gestão, Entregador, Pedidos). Útil para abrir só o endereço do túnel no celular. |
| **http://localhost:8080/painel/** (Painel de gestão) | quem apresenta, no notebook, e o telão | A central da loja: as **entregas ao vivo, com o GPS**, e os pedidos manuais. Mapa ao vivo com a loja, os entregadores 🛵 e os destinos dos pedidos. Ao lado, três abas: **Pedidos** (os entregadores, com a situação de cada um e há quanto tempo chegou o GPS dele, e a lista de pedidos com a situação em palavras simples) **QR** (o QR code que leva ao pedido e o link do entregador; o campo do túnel só aparece se o painel foi aberto por `localhost`) e **Testes** (os botões dos testes de falha do professor, que só funcionam com o painel aberto por `localhost`). **＋ Pedido pelo mapa** é o pedido manual: o formulário fica aberto, então dá para criar vários seguidos (clique no mapa, escolha o **tipo** (normal ou com o cupom da promoção) e o entregador, **Criar pedido**). Um 🎟️ ao lado do número mostra os pedidos que usaram o cupom. **Modo telão** esconde as ferramentas e mostra tudo em letras grandes. |
| **/cliente/?codigo=promo** (Pedidos) | a plateia, pelo QR code | O campo do **cupom** (`#promobcc`, opcional) e o botão de pedir: com o cupom o pedido usa uma das 10 unidades da promoção; sem cupom é um pedido normal. O navegador pergunta a localização e a entrega vai até onde o cliente está. Quando as 10 unidades acabam, a tela avisa "Cupom inválido" e só deixa fazer o pedido normal. Para entregar em **outro endereço**, ele toca em "Quero receber em outro endereço" e marca o ponto no mapa (o mesmo mapa aparece se o GPS não funcionar). Enquanto o pedido espera um entregador, "Fazer outro pedido" libera a tela para pedir de novo. Mostra quantas unidades restam e acompanha o pedido: recebido → unidade da promoção reservada (só com cupom) → pagando → procurando um entregador → entregador a caminho → entregue (ou o motivo da falha). |
| **/entregador/** (Entregador) | `entregador1` na tela da aula e `entregador2` no celular de um integrante (link `https://…` do túnel) | Botões **Disponível** / **Offline** e o cartão do **GPS** (verde = enviando, com a precisão). Os pedidos prontos para entrega aparecem em **Pedidos para entregar** (faixa, vibração e som), com a distância: quem tocar primeiro em **Aceitar** leva, e o outro entregador lê "já foi aceito". Aceito, a tela mostra o mapa com o endereço do cliente, a distância e **Confirmar entrega**. **O GPS vem desta página**: ela precisa ficar aberta, com a tela ligada. |
| **http://localhost:3000** (Grafana) | o telão e quem apresenta | A tela **Apresentação** (números, caminho de cada pedido, mapa dos serviços) e a **Detalhes técnicos** (para perguntas). Sem login. |
| **http://localhost:8099** (Testes do professor) | quem apresenta, no notebook | Os mesmos botões da aba **Testes** do painel de gestão, em tela cheia, para acionar os cenários de falha que o professor pedir (F1 a F8). Mostra a saída ao vivo, o PASSOU ou FALHOU e o que abrir no Grafana. Só abre no notebook; o `./demo.sh subir` já liga (ou `./demo.sh testes`). |
| http://localhost:15672 (RabbitMQ) | ninguém, em condições normais | **Não precisa abrir.** O Grafana já mostra as filas, as DLQs e os traces. Só serve para mostrar uma mensagem parada numa DLQ com as próprias mãos (`admin` / `admin`). |
| http://localhost:4566 (MiniStack) | ninguém | Não é uma tela: é a API da "nuvem" simulada. |

### Como um pedido passa pelas telas

| O que acontece | Tela Pedidos (cliente) | Tela do entregador | Painel de gestão |
|---|---|---|---|
| O cliente pede (com o cupom) | "Recebido", "Unidade da promoção reservada" e "Pagando…" (sem cupom, o pedido normal pula a reserva) | (nada ainda) | o pedido entra na lista: "Recebido", depois "Pagando" |
| O pagamento é aprovado | "🔎 Procurando um entregador…" | o pedido aparece em **Pedidos para entregar**, para todo entregador Disponível | "Aguardando entregador" e o destino no mapa |
| Um entregador toca em **Aceitar** | "🛵 Entregador a caminho" | o mapa com a entrega; para o outro entregador o pedido some da lista | "Em entrega" e o 🛵 andando |
| O entregador chega (menos de 50 m) ou toca em **Confirmar entrega** | "🎉 Entregue!" | "Entrega concluída. Bom trabalho!" | "Entregue" |

---

## 3. Grafana: tela "Apresentação" (a página inicial)

Pensada para a plateia. Atualiza sozinha a cada 5 segundos. O período fica no canto superior direito (padrão: últimos 15 minutos). **Dica:** um pedido leva uns 20 segundos para aparecer nas tabelas (o Grafana indexa o trace).

### Os seis números do topo
| Número | O que conta |
|---|---|
| **Pessoas que entraram** | quantas pessoas abriram o link do QR e entraram (uma por celular/aba) |
| **Pedidos feitos** | quantos pedidos chegaram ao sistema |
| **Pedidos confirmados** | os que reservaram a unidade **e** pagaram |
| **Sem sucesso** | esgotado, pagamento recusado ou demorou demais (o sistema desfez o que fez). Zero é normal |
| **Unidades restantes** | quantas da promoção ainda estão livres. Nunca passa de 10 nem fica negativo, mesmo com todos pedindo juntos |
| **Tempo do pagamento** | quanto o gateway demora, em média, para responder |

Se um serviço reiniciar, os contadores recomeçam do zero: é esperado.

### Os dois gráficos
- **Pedidos por minuto:** sobe quando a turma pede. É a "onda" da plateia.
- **Quanto cada serviço demora (média):** tempo que cada serviço leva para tratar uma mensagem. O pagamento é o mais lento porque chama o gateway.

### "O caminho do pedido" (o painel principal)
- **1. Pedidos recentes:** um pedido por linha, já com o **resultado**: ✅ Sucesso, ❌ Recusado (o pagamento falhou), ⏱️ Demorou demais (o prazo de pagamento venceu), 😕 Esgotado ou ↩️ Estornado (a aprovação chegou atrasada e foi devolvida). **Clique no número.** Só aparecem pedidos que já terminaram. **A lista e o caminho escolhido guardam as últimas 24 horas**, para dar tempo de analisar (o período do canto superior direito só vale para os números e gráficos de cima).
- **2. O caminho do pedido escolhido:** o mesmo pedido, serviço por serviço, na ordem em que aconteceu e quanto cada um demorou. É a versão "de dentro" da tela do cliente:

| O que aconteceu | Quem fez | O que significa |
|---|---|---|
| 📝 Pedido recebido (API) | Pedidos | o cliente recebeu o "202" na hora |
| 📦 Estoque separa a unidade | Estoque | a unidade foi reservada (tela do cliente: "Unidade reservada") |
| 🧭 Pedidos recebe a reserva | Pedidos | a saga avança |
| 💳 Pagamento cobra | Pagamento | começa a cobrança ("Pagando…") |
| 🏦 Gateway de pagamento (externo) | Gateway | a operadora responde |
| ✅ Pedidos confirma o pagamento | Pedidos | "Pedido confirmado!" |
| 📦 Estoque dá baixa (venda) | Estoque | a unidade reservada vira vendida |
| 🛵 Entregas recebe o pedido | Entregas | o pedido com endereço vira uma entrega que espera: aparece na lista dos entregadores até um tocar em Aceitar (o pedido sem endereço termina aqui, confirmado) |

Em caso de falha aparecem passos como "Estoque devolve a unidade" ou "Pedidos registra o estorno": é a compensação, visível no mesmo lugar. **Onde deu errado fica em vermelho** (coluna "Situação": ❌ registrou o erro, e "O que deu errado" diz o motivo). Num pagamento recusado, por exemplo, ficam vermelhos o Pagamento, o Gateway e o veredito do Pedidos; numa promoção esgotada, o Estoque e o Pedidos.

- **Detalhe técnico do pedido escolhido (fechado):** a cascata completa do trace, com cada chamada (HTTP, banco, fila). Para quem pergunta "e dentro do serviço?".

### "A arquitetura do pedido escolhido" e "Onde a falha começou"
O desenho da arquitetura **só para o pedido que você escolheu** na tabela (a mesma escolha do caminho do pedido). Cada caixa é um serviço e as setas mostram quem fala com quem: as ligadas ao RabbitMQ são mensagens e as outras são chamadas HTTP.

| Cor | O que quer dizer |
|---|---|
| 🟩 verde | o pedido passou por esse serviço sem erro |
| 🟥 vermelho | o serviço **registrou o erro** (foi onde ele nasceu ou o serviço que recebeu o erro e reagiu) |
| ⬜ cinza | o pedido não chegou até esse serviço |

**Como ler o vermelho.** Um erro nasce em um serviço e **volta pelo caminho por onde o pedido veio**; cada serviço que recebe o erro e reage (avisa, cancela, desfaz) também fica vermelho. Por isso há mais de uma caixa vermelha. A faixa **"Onde a falha começou"**, logo acima do desenho, diz em qual serviço o erro **nasceu** (o primeiro erro a terminar):

| Pedido | Onde a falha começou | O resto do vermelho |
|---|---|---|
| ❌ Recusado | Gateway de pagamento (a operadora recusou a cobrança) | o Pagamento avisou e o Pedidos cancelou o pedido; o Estoque ficou verde porque devolveu a unidade sem erro |
| 😕 Esgotado | Estoque (não havia mais unidades) | o Pedidos registrou o "esgotado" e encerrou o pedido |
| ⏱️ Demorou demais / ↩️ Estornado | Pedidos (o prazo do pagamento venceu e o pedido foi cancelado) | o estorno da aprovação que chegou atrasada |

Sem falha, a faixa mostra "Sem falha neste pedido". O desenho muda na hora em que você clica em outro pedido. A visão de **todos os pedidos somados** (com os bancos e o Redis) fica em "Detalhes técnicos", no último bloco.

---

## 4. Grafana: tela "Detalhes técnicos"

Abre pelo botão no topo da Apresentação. É para quando alguém pergunta algo específico ou para as falhas do professor.

| Painel | O que mostra | Quando olhar |
|---|---|---|
| **Pedidos por status** | quantas vezes cada status foi alcançado | confirmar que "recebidos" bate com "confirmados + sem sucesso" |
| **Estoque da promoção** | disponível + reservado + vendido = total | F5 (corrida): a soma nunca muda e nada fica negativo |
| **Pagamentos por resultado** | aprovado, recusado, estornado, por minuto | F1 (falha do pagamento) e F7 (aprovação tardia, estorno) |
| **Latência do gateway** | tempo de resposta da operadora | F7: passa do prazo e o pedido é cancelado |
| **Mensagens prontas nas filas** | fila de cada serviço esperando ser tratada | carga alta: se a fila cresce, o serviço está lento |
| **Mensagens nas DLQs** | mensagens que falharam várias vezes e foram para a fila de "mortas" | F4 (mensagem venenosa): sobe para 1 |
| **Outbox pendente** | mensagens gravadas no banco que ainda não saíram para o RabbitMQ | F6 (RabbitMQ fora): sobe e volta a zero sozinho |
| **Mensagens por réplica do pagamento** | uma linha por cópia do serviço de pagamento | F2 (uma cópia morre) e F8 (escala): a carga se divide |
| **Duplicadas descartadas e erros** | mensagens repetidas que o serviço reconheceu e ignorou | F3: mesma mensagem 5 vezes, um efeito só |
| **Compensações, recusas e erros (logs)** | as linhas de log de tudo que deu errado | achar o que aconteceu. Clique numa linha para ver o `correlationId` |

---

## 5. Perguntas rápidas

**Preciso abrir o RabbitMQ?** Não. O Grafana mostra filas, DLQs e traces.

**Qual tela eu mostro para provar o quê?**
| Quero provar | Mostro |
|---|---|
| que o pedido passa por todos os serviços | Apresentação → clique no pedido |
| a arquitetura funcionando, com o erro em vermelho e onde ele começou | Apresentação → escolha um pedido recusado ou esgotado → "Onde a falha começou" e "A arquitetura do pedido escolhido" |
| que a plateia está pedindo | os números do topo e "Pedidos por minuto" |
| que não vende mais que o estoque | "Unidades restantes" (e "Estoque da promoção" em Detalhes técnicos) |
| que o sistema se recupera de falhas | os scripts F1–F8 com "Detalhes técnicos" aberto |
| o GPS | Painel de gestão (marcador e "última posição há X s") e a página do entregador (cartão do GPS) |

**Por que um pedido não aparece na tabela?** Espere uns 20 segundos e confira o período no canto superior direito.

**O que é "user" no mapa?** Quem chama o sistema de fora: o navegador, o simulador e os testes.
