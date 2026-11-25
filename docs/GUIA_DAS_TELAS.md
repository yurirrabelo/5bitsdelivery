# Guia das telas: o que cada site e cada painel mostra

Para quem não sabe o que está olhando. Começa pelo que é real e o que é simulado, depois cada site, depois o Grafana.

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
| **http://localhost:8080/painel/** (Painel de gestão) | quem apresenta, no notebook, e o telão | A central da loja: as **entregas ao vivo, com o GPS**, e os pedidos manuais. Mapa ao vivo com a loja, os entregadores 🛵 e os destinos dos pedidos. Só aparece no mapa quem está mandando GPS agora (nos últimos 2 minutos): a posição de um celular que saiu, ou de um teste antigo, não fica lá como se fosse um entregador de verdade. Ao lado, o botão **🧪 Testes de falha** (abre a tela de testes, veja abaixo; só aparece com o painel aberto por `localhost`) e duas abas: **Pedidos** (os entregadores, com a situação de cada um e há quanto tempo chegou o GPS dele, e a lista de pedidos com a situação em palavras simples) e **QR** (o QR code que leva ao pedido e o link do entregador; o campo do túnel só aparece se o painel foi aberto por `localhost`). **＋ Pedido pelo mapa** é o pedido manual: o formulário fica aberto, então dá para criar vários seguidos (clique no mapa, escolha o entregador, se quiser, e **Criar pedido**). **Modo telão** esconde as ferramentas e mostra tudo em letras grandes. |
| **/cliente/?codigo=promo** (Pedidos) | a plateia, pelo QR code | O botão **Pedir item**. O navegador pergunta a localização e a entrega vai até onde o cliente está. Quando as 10 unidades acabam, o pedido termina como "Item esgotado". Para entregar em **outro endereço**, ele toca em "Quero receber em outro endereço" e marca o ponto no mapa (o mesmo mapa aparece se o GPS não funcionar). Enquanto o pedido espera um entregador, "Fazer outro pedido" libera a tela para pedir de novo. Mostra quantas unidades restam e acompanha o pedido: recebido → unidade reservada → pagando → procurando um entregador → entregador a caminho → entregue (ou o motivo da falha). |
| **/entregador/** (Entregador) | `entregador1` na tela da aula e `entregador2` no celular de um integrante (link `https://…` do túnel) | Botões **Disponível** / **Offline** e o cartão do **GPS** (verde = enviando, com a precisão). Os pedidos prontos para entrega aparecem em **Pedidos para entregar** (faixa, vibração e som), com a distância: quem tocar primeiro em **Aceitar** leva, e o outro entregador lê "já foi aceito". Aceito, a tela mostra o mapa com o endereço do cliente, a distância e **Confirmar entrega**. **O GPS vem desta página**: ela precisa ficar aberta, com a tela ligada. |
| **http://localhost:3000** (Grafana) | o telão e quem apresenta | Uma tela só, **5Bits Delivery** (veja a seção 3). Só leitura, sem login. Também abre pelo link público: o `./demo.sh link` mostra o endereço. |
| **http://localhost:8099** (Testes de falha) | quem apresenta, no notebook | Uma página simples, aberta pelo botão **🧪 Testes de falha** do painel de gestão. Para cada falha (F1 a F8): o botão **Acionar teste falha N**, **como o erro é provocado**, **onde ele acontece**, **o que acontece**, o **resultado esperado** e **o que tentar de novo**. O botão roda o teste e mostra a saída (logs, estado dos bancos, esperado × obtido e PASSOU ou FALHOU). Cada teste começa com o banco zerado. Os botões só funcionam no notebook; o `./demo.sh subir` já liga (ou `./demo.sh testes`). A mesma página abre só para leitura em `/testes/`, inclusive pelo link público. |
| http://localhost:15672 (RabbitMQ) | ninguém, em condições normais | **Não precisa abrir.** O Grafana já mostra as DLQs e a outbox. Só serve para mostrar uma mensagem parada numa DLQ com as próprias mãos (`admin` / `admin`). |
| http://localhost:4566 (MiniStack) | ninguém | Não é uma tela: é a API da "nuvem" simulada. |

### Como um pedido passa pelas telas

| O que acontece | Tela Pedidos (cliente) | Tela do entregador | Painel de gestão |
|---|---|---|---|
| O cliente pede o item | "Recebido", "Unidade reservada para você" e "Pagando…" | (nada ainda) | o pedido entra na lista: "Recebido", depois "Pagando" |
| O pagamento é aprovado | "🔎 Procurando um entregador…" | o pedido aparece em **Pedidos para entregar**, para todo entregador Disponível | "Aguardando entregador" e o destino no mapa |
| Um entregador toca em **Aceitar** | "🛵 Entregador a caminho" | o mapa com a entrega; para o outro entregador o pedido some da lista | "Em entrega" e o 🛵 andando |
| O entregador chega (menos de 50 m) ou toca em **Confirmar entrega** | "🎉 Entregue!" | "Entrega concluída. Bom trabalho!" | "Entregue" |

---

## 3. Grafana: uma tela só

Atualiza sozinha a cada 5 segundos. O período fica no canto superior direito (padrão: últimos 15 minutos). Passe o mouse no ⓘ de cada painel para ler o que ele conta. **Dica:** um pedido leva uns 20 segundos para aparecer nas tabelas (o Grafana indexa o trace).

### Os quatro números do topo
| Número | O que conta |
|---|---|
| **Pedidos feitos** | quantos pedidos chegaram ao sistema |
| **Confirmados** | os que reservaram a unidade **e** pagaram |
| **Sem sucesso** | esgotado, pagamento recusado ou demorou demais (o sistema desfez o que fez). Zero é normal |
| **Unidades restantes** | quantas unidades do item ainda estão livres. Nunca passa do total nem fica negativo, mesmo com todos pedindo juntos |

Se um serviço reiniciar, os contadores recomeçam do zero: é esperado.

### Os quatro gráficos
| Gráfico | O que mostra | Quando olhar |
|---|---|---|
| **Pedidos por minuto** | sobe quando a turma pede: é a "onda" da plateia | F5 e F8 (carga) |
| **Pagamentos por cópia** | uma linha por cópia do serviço de pagamento | F2 (uma cópia morre) e F8 (escala): a carga se divide |
| **Quarentena (DLQ)** | mensagens que falharam várias vezes e foram separadas para não travar as outras | F4 (mensagem venenosa): sobe para 1 |
| **Esperando envio (outbox)** | mensagens gravadas no banco que ainda não saíram para o RabbitMQ | F6 (RabbitMQ fora): sobe e volta a zero sozinho |

### As duas tabelas: o caminho do pedido
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

Em caso de falha aparecem passos como "Estoque devolve a unidade" ou "Pedidos registra o estorno": é a compensação, visível no mesmo lugar. **Onde deu errado fica em vermelho** (coluna "Situação": ❌ registrou o erro, e "O que deu errado" diz o motivo). Num pagamento recusado, por exemplo, ficam vermelhos o Pagamento e o Gateway; num item esgotado, o Estoque.

---

## 4. Perguntas rápidas

**Preciso abrir o RabbitMQ?** Não. O Grafana mostra a quarentena (DLQ) e a outbox.

**Qual tela eu mostro para provar o quê?**
| Quero provar | Mostro |
|---|---|
| que o pedido passa por todos os serviços | Grafana → clique no pedido na tabela |
| onde o erro aconteceu | Grafana → clique num pedido recusado ou esgotado: o caminho mostra em vermelho onde deu erro |
| que a plateia está pedindo | os números do topo e "Pedidos por minuto" |
| que não vende mais que o estoque | "Unidades restantes" |
| que o sistema se recupera de falhas | os testes F1 a F8 (http://localhost:8099) com o Grafana aberto |
| o GPS | Painel de gestão (marcador e "última posição há X s") e a página do entregador (cartão do GPS) |

**Por que um pedido não aparece na tabela?** Espere uns 20 segundos e confira o período no canto superior direito.

**O que é "user" no mapa?** Quem chama o sistema de fora: o navegador, o simulador e os testes.
