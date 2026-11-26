# Cola dos cenários de falha

O professor escolhe uma falha e o grupo a provoca ao vivo, **mostrando pelos logs e pelo estado dos bancos** que o sistema se comportou como esperado. Antes de executar, o grupo **diz o que vai acontecer** (o "resultado esperado" abaixo).

**Com botões:** abra http://localhost:8099 (o `./demo.sh subir` já liga essa tela; o painel de gestão, aberto no notebook por `http://localhost:8080/painel/`, tem um botão para ela; precisa do Python 3). Para cada falha a tela mostra **como o erro é provocado**, **onde ele acontece**, **o que acontece**, o **resultado esperado** e **o que tentar de novo**. O botão **Acionar teste falha N** roda o teste e mostra a saída: os logs, o estado dos bancos, o esperado × o obtido e o PASSOU ou FALHOU.

**Pelo terminal** (a mesma coisa):

```bash
./demo.sh falha        # mostra a lista e pergunta o número
./demo.sh falha 3      # roda direto o F3
```

Cada teste começa com o banco zerado (pedidos, entregas, estoque nos 30 itens (10 com cupom e 20 normais), entregadores livres, sem posição de GPS e as DLQs vazias) e, ao terminar, devolve o sistema ao normal (a mensagem do F4 fica na DLQ, para mostrar). Leva de 1 a 3 minutos. **Não rode com pedidos de verdade em andamento** (por exemplo, no meio da plateia pedindo pelo QR): o teste os apaga.

**Por que a tela dos testes só abre no notebook?** Os testes derrubam coisas de verdade (RabbitMQ, cópias do pagamento, nuvem), e isso só um comando na máquina faz. A tela é um servidor pequeno do notebook (`scripts/testes/servidor.py`) que só atende páginas de `localhost`. O painel de gestão também abre pelo link público e a plateia enxerga esse link: um botão que derruba o sistema ali seria um risco. Por isso a mesma página (`web/testes/index.html`) também abre pelo link público em `/testes/`, só para leitura, com os botões desligados.

## O que o professor pede (do enunciado)

| # | Como provocar | Resultado esperado |
|---|---|---|
| **F1** Compensação | Taxa de falha da dependência em 100% | Passos anteriores desfeitos, recurso liberado, cliente notificado |
| **F2** Serviço morre no meio | `docker kill` no consumidor durante o processamento | Mensagem reentregue a outra réplica ou após o reinício, efeito aplicado uma única vez |
| **F3** Mensagem duplicada | Republicar a mesma mensagem (mesmo `messageId`) 5 vezes | Um único efeito |
| **F4** Mensagem venenosa | Publicar payload inválido | N tentativas, depois DLQ; as demais mensagens seguem normalmente |
| **F5** Corrida pelo recurso | 100 requisições simultâneas para 10 unidades (aqui: 100 pedidos com o cupom para os 10 itens com cupom) | Exatamente 10 sucessos; as outras 90 recusadas ou compensadas |
| **F6** Broker fora do ar | Parar o broker (ou o MiniStack) por 30 segundos | Serviços reconectam sozinhos, outbox drena, nenhuma mensagem perdida |
| **F7** Resposta tardia | Latência da dependência maior que o tempo de expiração | Compensação correta do resultado que chegou atrasado |
| **F8** Escala horizontal | Subir 3 réplicas de um consumidor | Carga dividida entre as réplicas, sem efeito duplicado |

O professor também pode pedir uma **falha surpresa** (por exemplo, derrubar um serviço específico). Nesse caso não há botão: `docker compose stop <serviço>`, **diga em voz alta o que vai acontecer**, mostre e depois `docker compose start <serviço>`.

## O que o nosso teste faz em cada um

| # | Como o erro é provocado (o "mock") | Onde o erro acontece | O que acontece, e o resultado esperado |
|---|---|---|---|
| **F1** | o gateway é recriado com `GATEWAY_TAXA_FALHA=100`: toda cobrança dá erro | no gateway de pagamento, quando o pagamento tenta cobrar | pagamento recusado, pedido `CANCELADO` (pagamento recusado) e a unidade volta ao estoque |
| **F2** | gateway lento (`GATEWAY_LATENCIA_MS=8000`) e `docker kill` na cópia do pagamento que pegou a mensagem | no serviço de pagamento: uma das 2 cópias morre no meio da cobrança | a mensagem não foi confirmada, então a outra cópia a recebe e chama o gateway com a mesma chave: pedido `CONFIRMADO` com **uma** cobrança só |
| **F3** | a mesma mensagem `estoque.reservar` (mesmo `messageId`) publicada 5 vezes no RabbitMQ | na fila do estoque; quem se protege é o estoque, com a inbox (`mensagens_processadas`) | uma reserva só; as outras 4 são descartadas ("mensagem duplicada descartada") |
| **F4** | uma mensagem `estoque.reservar` inválida (`pedidoId` não numérico) publicada no RabbitMQ, e 3 pedidos normais ao mesmo tempo | no estoque, ao conferir a mensagem com o contrato | 3 tentativas e a mensagem vai para a DLQ `estoque.entrada.dlq`; os 3 pedidos seguem `CONFIRMADO` |
| **F5** | o k6 cria 100 clientes que pedem ao mesmo tempo, todos com o cupom, os 10 itens com cupom (os outros 20 itens do estoque ficam de fora) | no estoque: os 100 pedidos disputam a mesma linha do banco | `UPDATE ... WHERE disponivel > 0`: exatamente 10 `CONFIRMADO` e 90 `ESGOTADO`, estoque nunca negativo |
| **F6** | `docker compose stop rabbitmq` por 30 s, com 60 pedidos por minuto chegando | no RabbitMQ: ninguém consegue enviar nem receber mensagens | a API segue com `202`, a outbox cresce e depois esvazia, os serviços reconectam sozinhos (sem reiniciar) e nenhum pedido fica parado |
| **F6b** | `docker compose stop ministack` (S3 e segredos) durante uma entrega | no MiniStack, na hora em que o serviço de entregas exporta a rota para o S3 | o pedido termina `ENTREGUE`; a rota fica pendente e sobe para o S3 quando ele volta; os segredos continuam lá |
| **F7** | gateway com latência de 20 s (`GATEWAY_LATENCIA_MS=20000`), maior que o prazo de 15 s | no gateway: ele aprova depois que o pedido já foi cancelado | cancelado no prazo (`PRAZO_EXPIRADO`) e a unidade volta; quando a aprovação chega, ela é estornada (`ESTORNADO`) |
| **F8** | `docker compose up --scale pagamento=3`, gateway de 1 s e 120 pedidos por minuto | não há erro: 3 cópias leem a mesma fila (`pagamento.entrada`) | a carga se divide entre as cópias, sem pagamento duplicado e sem cobrança repetida no gateway |

Ao terminar, cada teste escreve em **"Mostre agora"** o que abrir no Grafana, e a tela de testes traz a mesma dica no quadro azul **Onde ver**. No fim da tela do Grafana há **uma linha recolhida para cada teste** (clique no nome para abrir): um texto curto, os números e o registro daquele teste.

| # | Linha do Grafana | O que olhar |
|---|---|---|
| **F1** | «F1 · Compensação» | "Recusados" e "Cancelados" sobem e o registro mostra o pagamento recusado. Em cima, clique no pedido "Recusado": o desenho mostra em vermelho o gateway, o pagamento e o pedidos |
| **F2** | «F2 · Serviço morre» | "Refeitos" = 1 e o registro do gateway mostra "cobrança repetida (mesma chave)", sem cobrar de novo. Em cima, "Pagamentos por cópia": uma cópia para e a outra assume; no pedido, 2 linhas do gateway (a mesma chave) e 1 cobrança |
| **F3** | «F3 · Mensagem duplicada» | "Duplicadas" sobe 4 e o registro mostra o mesmo `messageId` 4 vezes (o pedido não existe, então não aparece na tabela) |
| **F4** | «F4 · Mensagem venenosa» | "Na DLQ" = 1, "Erros" = 3 e o registro das 3 tentativas. A mensagem fica na DLQ até o próximo F4 ou `./demo.sh limpar`; no RabbitMQ, a fila `estoque.entrada.dlq` mostra o conteúdo dela em **Get messages** |
| **F5** | «F5 · Corrida pelo estoque» | "Confirmados" = 10, "Esgotados" = 90 e os itens com cupom restantes caem a 0 e não passam disso |
| **F6** | «F6 · RabbitMQ fora do ar» | a faixa "RabbitMQ: no ar ou fora" (abaixo dos gráficos) fica vermelha, "Esperando envio (outbox)" sobe e volta a 0, "Pico outbox" e o registro dos serviços perdendo e retomando a conexão. No RabbitMQ a tela dele fica fora do ar durante a queda; depois, o "Uptime" do nó zera e a aba Connections mostra as conexões novas |
| **F6b** | «F6b · Nuvem (S3) fora do ar» | "Pendentes" e "Exportadas" e o registro "exportação da rota pendente" e depois "rota exportada para o S3"; o arquivo da rota abre em `http://localhost:4566/delivery-rotas/rotas/pedido-N.geojson` |
| **F7** | «F7 · Resposta tardia» | "Por prazo" e "Estornados" sobem e o registro mostra o prazo vencido e o estorno. Em cima, clique no pedido "Estornado" |
| **F8** | «F8 · Escala» | "Cópias" = 3 e as barras mostram quantos pedidos cada cópia processou; em cima, "Pagamentos por cópia" mostra as 3 linhas dividindo a carga |

Os números e o registro de cada linha olham o período do canto superior direito do Grafana (padrão: 15 minutos), então mostram o teste que acabou de rodar. Os painéis levam de alguns segundos a uns 30 s para mostrar (a telemetria chega em lotes).

`./demo.sh falha todas` roda todos em sequência (uns 14 minutos): serve para ensaiar, não para a apresentação.

## Dicas

- **Um por vez.** Dois cenários ao mesmo tempo atrapalham um ao outro.
- **Antes:** `./demo.sh estado` confere que está tudo no ar (containers `healthy`, filas e DLQs vazias).
- **Depois de um cenário** o sistema volta ao normal sozinho, mas o que ele provocou fica no banco (para mostrar). Para começar limpo: `./demo.sh limpar`.
- **Não mexa** em `docker-compose.yml`, `.env` ou nos arquivos do Terraform enquanto um cenário roda.
- **Pedidos no Grafana:** os pedidos dos cenários aparecem na tabela "Pedidos recentes" por 1 hora. Clique no número de um deles e a tabela do lado mostra por quais serviços ele passou, em ordem, e onde deu erro; embaixo, o desenho da arquitetura mostra por onde o erro passou (vermelho).
