# Cola dos cenários de falha

O professor vai escolher um (ou alguns) ao acaso: rode **só o que ele pedir**, um de cada vez.

**Com botões** (o jeito mais fácil na apresentação): no **painel de gestão**, aberto no notebook por `http://localhost:8080/painel/`, clique na aba **Testes**. (O `./demo.sh subir` já liga a tela de testes que a aba usa; se ela avisar que não está ligada, rode `./demo.sh testes`, que a liga e abre a mesma tela em `http://localhost:8099`.)

A aba mostra uma lista com os 9 testes, cada um com o que o professor costuma perguntar, o que acontece e o resultado esperado, e um botão **Acionar**. A saída aparece ao vivo no quadro ao lado (`[OK]` verde e `[ERRO]` vermelho) e, no fim, vem um **PASSOU** grande e o que mostrar no Grafana. O botão **Voltar ao normal** religa o que um teste tenha parado, se algo ficar estranho. (Precisa do Python 3 no notebook. Sem ele, use os comandos abaixo.)

Também dá para acionar pelo terminal:

```bash
./demo.sh falha        # mostra a lista e pergunta o número
./demo.sh falha 3      # roda direto o F3
```

Cada cenário **provoca a falha de verdade** (para um serviço, derruba o broker, manda mensagem repetida...), espera o sistema reagir e compara o **esperado** com o **obtido**. No fim aparece **PASSOU** (ou **FALHOU**) e uma linha **"Mostre agora"** dizendo o que abrir no Grafana. Leva de 1 a 3 minutos cada. Ao terminar, o cenário devolve o sistema ao normal sozinho.

**Por que a aba Testes só funciona por `localhost`?** Os cenários derrubam coisas de verdade (RabbitMQ, réplicas, nuvem), e isso só um comando na máquina pode fazer: por baixo, a aba chama uma tela de testes que roda no notebook (`scripts/testes`) e só atende páginas de `localhost`. O painel de gestão também abre pelo túnel da internet, com login simples, e a plateia enxerga esse link: um botão que desliga o sistema ali seria um risco. Pelo link público a aba apenas avisa que os testes só funcionam no notebook.

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
- **Depois de um cenário** o sistema volta ao normal sozinho. Se sobrar estoque estranho: `./demo.sh reset`.
- **Não mexa** em `docker-compose.yml`, `.env` ou nos arquivos do Terraform enquanto um cenário roda.
- **Pedidos que ficam no Grafana:** os pedidos dos cenários aparecem na tabela "Pedidos recentes" por 24 horas. Escolha um deles e a **arquitetura do pedido** mostra onde a falha aconteceu, em vermelho.
