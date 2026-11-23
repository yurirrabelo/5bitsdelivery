# Cola dos cenários de falha

O professor vai escolher um (ou alguns) ao acaso: rode **só o que ele pedir**, um de cada vez. No enunciado, o professor escolhe uma falha e o grupo a provoca ao vivo, **mostrando pelos logs e pelo estado dos bancos** que o sistema se comportou como esperado. E o grupo deve **prever o que vai acontecer antes de executar**: a tela de testes já traz essa previsão escrita.

**Com botões** (o jeito mais fácil na apresentação): no **painel de gestão**, aberto no notebook por `http://localhost:8080/painel/`, clique em **🧪 Testes de falha** (na lateral, acima das abas). Abre uma tela própria, em tela cheia, em `http://localhost:8099`. O `./demo.sh subir` já a liga; se o botão estiver apagado, rode `./demo.sh testes`. (Precisa do Python 3 no notebook. Sem ele, use os comandos abaixo.)

A tela tem três zonas:

- **À esquerda**, os 9 cenários, cada um com as palavras do professor (a coluna "Como provocar" da tabela do enunciado).
- **No centro**, a história do cenário, na ordem em que se conta: 1) **o que o professor pede**; 2) o **passo a passo, com o porquê de cada passo**; 3) o **resultado esperado** (para dizer em voz alta *antes* de provocar); 4) **"Agora faça um pedido"**: o que o cliente vê (por exemplo, "Não foi possível: pagamento recusado"). O botão **▶ Provocar a falha** fica sempre à vista. Ao apertar, os passos acendem um a um e, no fim, o **resultado** aparece no alto: o PASSOU ou FALHOU, a tabela **esperado × obtido**, o caminho do pedido e o **"Mostre agora"** com os botões do Grafana.
- **À direita, ao vivo:** o andamento e o relógio, o **estado dos bancos** (estoque, pedidos, pagamentos e as mensagens esperando na outbox, que mudam enquanto o teste roda) e os **logs** do teste. O botão **↺ Voltar ao normal** religa o que um teste tenha parado, se algo ficar estranho.

**Cada teste começa com o banco zerado** (pedidos, entregas, estoque de volta nas 10 unidades, entregadores livres e sem posição de GPS), para o resultado ser fácil de ler e nada se misturar com testes anteriores. O que o teste provoca fica no banco até o próximo começar, para dar tempo de mostrar. Por isso, **não use a tela de testes com pedidos de verdade em andamento** (por exemplo, no meio da plateia pedindo pelo QR): ela os apaga.

Também dá para acionar pelo terminal (mesma coisa, com o mesmo banco zerado no início):

```bash
./demo.sh falha        # mostra a lista e pergunta o número
./demo.sh falha 3      # roda direto o F3
```

Cada cenário **provoca a falha de verdade** (para um serviço, derruba o broker, manda mensagem repetida...), espera o sistema reagir e compara o **esperado** com o **obtido**. No fim aparece **PASSOU** (ou **FALHOU**) e uma linha **"Mostre agora"** dizendo o que abrir no Grafana. Leva de 1 a 3 minutos cada. Ao terminar, o cenário devolve o sistema ao normal sozinho. O texto de cada cenário (o que o professor pede, os passos, o porquê, o esperado e o que o cliente vê) está em `scripts/testes/cenarios.json`.

**Por que o botão só funciona por `localhost`?** Os cenários derrubam coisas de verdade (RabbitMQ, réplicas, nuvem), e isso só um comando na máquina pode fazer: por baixo, a tela chama um servidor local do notebook (`scripts/testes`) que só atende páginas de `localhost`. O painel de gestão também abre pelo túnel da internet, com login simples, e a plateia enxerga esse link: um botão que desliga o sistema ali seria um risco. Pelo link público o botão nem aparece.

## O que o professor pede (do enunciado)

| # | Como provocar | Resultado esperado |
|---|---|---|
| **F1** Compensação | Taxa de falha da dependência em 100% | Passos anteriores desfeitos, recurso liberado, cliente notificado |
| **F2** Serviço morre no meio | `docker kill` no consumidor durante o processamento | Mensagem reentregue a outra réplica ou após o reinício, efeito aplicado uma única vez |
| **F3** Mensagem duplicada | Republicar a mesma mensagem (mesmo `messageId`) 5 vezes | Um único efeito |
| **F4** Mensagem venenosa | Publicar payload inválido | N tentativas, depois DLQ; as demais mensagens seguem normalmente |
| **F5** Corrida pelo recurso | 100 requisições simultâneas para 10 unidades | Exatamente 10 sucessos; as outras 90 recusadas ou compensadas |
| **F6** Broker fora do ar | Parar o broker (ou o MiniStack) por 30 segundos | Serviços reconectam sozinhos, outbox drena, nenhuma mensagem perdida |
| **F7** Resposta tardia | Latência da dependência maior que o tempo de expiração | Compensação correta do resultado que chegou atrasado |
| **F8** Escala horizontal | Subir 3 réplicas de um consumidor | Carga dividida entre as réplicas, sem efeito duplicado |

O professor também pode pedir uma **falha surpresa** (por exemplo, derrubar um serviço específico). Nesse caso não há botão: `docker compose stop <serviço>`, **diga em voz alta o que vai acontecer**, mostre e depois `docker compose start <serviço>`.

## Como o nosso teste responde a cada um

| # | O que acontece | Resultado esperado | Onde mostrar no Grafana |
|---|---|---|---|
| **F1** Compensação | o gateway passa a recusar 100% dos pagamentos e um pedido é feito | pedido `CANCELADO` (pagamento recusado), a unidade volta ao estoque, nada fica reservado | **Apresentação**: escolha o pedido ❌ Recusado; a arquitetura do pedido pinta Pagamento, Gateway e Pedidos de vermelho e a tabela mostra "Estoque devolve a unidade" |
| **F2** Serviço morre | a réplica do pagamento que pegou a mensagem é morta (`docker kill`) no meio do trabalho | a outra réplica assume e o pedido termina `CONFIRMADO` com **uma** cobrança só (a retomada usa a mesma chave de idempotência) | **Detalhes técnicos** → "Mensagens processadas por réplica do pagamento" |
| **F3** Mensagem duplicada | a mesma mensagem `estoque.reservar` é publicada 5 vezes, com o mesmo `messageId` | uma reserva só; as outras 4 são descartadas (inbox) | **Detalhes técnicos** → "Duplicadas descartadas e erros" |
| **F4** Mensagem venenosa | uma mensagem com conteúdo inválido entra na fila do estoque | 3 tentativas e a mensagem vai para a DLQ; os pedidos normais feitos junto seguem `CONFIRMADO` | **Detalhes técnicos** → "Mensagens nas DLQs" |
| **F5** Corrida pelo estoque | 100 clientes pedem ao mesmo tempo as 10 unidades | exatamente 10 `CONFIRMADO` e 90 `ESGOTADO`, estoque nunca negativo | **Apresentação**: "Unidades restantes" zera e "Sem sucesso" sobe; escolha um 😕 Esgotado e veja o Estoque em vermelho |
| **F6** Broker fora | o RabbitMQ para por 30 s com pedidos chegando | a API continua respondendo `202`, a outbox cresce e depois drena, os serviços reconectam sozinhos, nenhum pedido fica parado | **Detalhes técnicos** → "Outbox pendente por serviço" e "Mensagens prontas nas filas" |
| **F6b** Nuvem fora | o MiniStack (S3 e segredos) para durante uma entrega | o pedido segue e termina `ENTREGUE`; a rota fica pendente e é enviada ao S3 quando ele volta; os segredos continuam lá | pelo terminal (linhas "arquivo no S3" e "segredos continuam lá") |
| **F7** Resposta tardia | o gateway demora mais que o prazo de pagamento | o pedido é cancelado **no prazo** (`PRAZO_EXPIRADO`), a unidade volta e, quando a aprovação chega, ela é estornada (`ESTORNADO`) | **Apresentação**: escolha o pedido ↩️ Estornado; **Detalhes técnicos** → "Pagamentos por resultado" e "Latência do gateway" |
| **F8** Escala | o pagamento sobe para 3 réplicas e chega carga | a carga se divide entre as réplicas, sem pagamento duplicado e sem cobrança repetida no gateway | **Detalhes técnicos** → "Mensagens processadas por réplica do pagamento" |

`./demo.sh falha todas` roda todos em sequência (uns 14 minutos): serve para ensaiar, não para a apresentação.

## Dicas

- **Um por vez.** Dois cenários ao mesmo tempo atrapalham um ao outro.
- **Antes:** `./demo.sh estado` confere que está tudo no ar (containers `healthy`, filas e DLQs vazias).
- **Depois de um cenário** o sistema volta ao normal sozinho, mas o que ele provocou fica no banco (para mostrar). Para começar limpo: `./demo.sh limpar`.
- **Não mexa** em `docker-compose.yml`, `.env` ou nos arquivos do Terraform enquanto um cenário roda.
- **Pedidos que ficam no Grafana:** os pedidos dos cenários aparecem na tabela "Pedidos recentes" por 24 horas. Escolha um deles e a **arquitetura do pedido** mostra onde a falha aconteceu, em vermelho.
