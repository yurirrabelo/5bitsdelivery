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
| **http://localhost:8080** (Entrada) | operador e entregador | Um login só: quem é operador vai para o painel e quem é entregador vai para a tela do entregador. Útil para abrir só o endereço do túnel no celular. |
| **http://localhost:8080/painel/** (Painel do operador) | o operador, no notebook, e o telão | A central da loja, para **acompanhar** (não precisa mexer em nada). Mapa ao vivo com a loja, os entregadores 🛵 e os destinos dos pedidos. Ao lado, duas abas: **Pedidos** (os entregadores, com a situação de cada um e há quanto tempo chegou o GPS dele, e a lista de pedidos com a situação em palavras simples) e **QR da plateia** (o QR code e o link do entregador). **＋ Pedido pelo mapa** é uma ferramenta de apoio para criar um pedido sem ser cliente. **Modo telão** esconde as ferramentas e mostra tudo em letras grandes. |
| **/cliente/?codigo=promo** (Cliente) | a plateia, pelo QR code | Um botão só: **Quero um pedido!**. O navegador pergunta a localização: a entrega vai até onde o cliente está (sem GPS, ele toca no mapa). Mostra quantas unidades restam e acompanha o pedido: recebido → unidade reservada → pagando → procurando um entregador → entregador a caminho → entregue (ou o motivo da falha). |
| **/entregador/** (Entregador) | `entregador1` na tela da aula e `entregador2` no celular de um integrante (link `https://…` do túnel) | Botões **Disponível** / **Offline** e o cartão do **GPS** (verde = enviando, com a precisão). Os pedidos prontos para entrega aparecem em **Pedidos para entregar** (faixa, vibração e som), com a distância: quem tocar primeiro em **Aceitar** leva, e o outro entregador lê "já foi aceito". Aceito, a tela mostra o mapa com o endereço do cliente, a distância e **Confirmar entrega**. **O GPS vem desta página**: ela precisa ficar aberta, com a tela ligada. |
| **http://localhost:3000** (Grafana) | o telão e quem apresenta | A tela **Apresentação** (números, caminho de cada pedido, mapa dos serviços) e a **Detalhes técnicos** (para perguntas). Sem login. |
| http://localhost:15672 (RabbitMQ) | ninguém, em condições normais | **Não precisa abrir.** O Grafana já mostra as filas, as DLQs e os traces. Só serve para mostrar uma mensagem parada numa DLQ com as próprias mãos (`admin` / `admin`). |
| http://localhost:4566 (MiniStack) | ninguém | Não é uma tela: é a API da "nuvem" simulada. |

### Como um pedido passa pelas telas

| O que acontece | Tela do cliente | Tela do entregador | Painel do operador |
|---|---|---|---|
| O cliente pede | "Recebido", "Unidade reservada" e "Pagando…" | (nada ainda) | o pedido entra na lista: "Recebido", depois "Pagando" |
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
- **1. Pedidos recentes:** um pedido por linha, já com o **resultado**: ✅ Sucesso, ❌ Recusado (o pagamento falhou), ⏱️ Demorou demais (o prazo de pagamento venceu), 😕 Esgotado ou ↩️ Estornado (a aprovação chegou atrasada e foi devolvida). **Clique no número.** Só aparecem pedidos que já terminaram.
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

Em caso de falha aparecem passos como "Estoque devolve a unidade" ou "Pedidos registra o estorno": é a compensação, visível no mesmo lugar. **Onde deu errado fica em vermelho** (coluna "Situação": ❌ falhou aqui, e "O que deu errado" diz o motivo). Num pagamento recusado, por exemplo, ficam vermelhos o Pagamento, o Gateway e o veredito do Pedidos; numa promoção esgotada, o Estoque e o Pedidos.

- **Detalhe técnico do pedido escolhido (fechado):** a cascata completa do trace, com cada chamada (HTTP, banco, fila). Para quem pergunta "e dentro do serviço?".

### "A arquitetura funcionando" (mapa de serviços)
O desenho da arquitetura, **ao vivo e somando todos os pedidos do período** (não é só o pedido escolhido, por isso o desenho é sempre o mesmo; o que muda são os números e as cores). Cada círculo é um serviço ou banco, cada seta é uma chamada, e o número dentro é o tempo médio e as chamadas por segundo. **`user`** é quem chama de fora (navegador, simulador, teste de carga). **`pg-…`** são os bancos e **`redis`** é o Redis. As setas entre serviços passam pelo RabbitMQ. **Quando algo falha, o anel do serviço onde aconteceu fica vermelho**, na proporção das falhas: poucas falhas entre muitos pedidos dão só uma fatia pequena. Para o vermelho ficar bem visível, olhe um período curto (canto superior direito) logo depois de provocar uma falha.

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
| a arquitetura funcionando | Apresentação → mapa de serviços |
| que a plateia está pedindo | os números do topo e "Pedidos por minuto" |
| que não vende mais que o estoque | "Unidades restantes" (e "Estoque da promoção" em Detalhes técnicos) |
| que o sistema se recupera de falhas | os scripts F1–F8 com "Detalhes técnicos" aberto |
| o GPS | Painel do operador (marcador e "última posição há X s") e a página do entregador (cartão do GPS) |

**Por que um pedido não aparece na tabela?** Espere uns 20 segundos e confira o período no canto superior direito.

**O que é "user" no mapa?** Quem chama o sistema de fora: o navegador, o simulador e os testes.
