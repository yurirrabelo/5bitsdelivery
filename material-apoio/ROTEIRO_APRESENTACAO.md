# Roteiro da apresentação (5 pessoas, ~20 min)

Ideia: quatro pessoas apresentam e fazem a demonstração; a quinta, o entregador, **chega na sala com o pedido** como grande final e explica o GPS e a comunicação com o celular. Depois a plateia pede pelo QR code e vê os traces nascerem no Grafana.

Se algo aqui não estiver claro, as telas estão explicadas em [docs/GUIA_DAS_TELAS.md](../docs/GUIA_DAS_TELAS.md) e o passo a passo para montar tudo em [PASSO_A_PASSO.md](../PASSO_A_PASSO.md).

## Quem faz o quê

| Pessoa | Papel | Fala sobre |
|---|---|---|
| **1** | Abertura | o problema (promoção relâmpago, muita gente pedindo, nada pode ser vendido a mais) e o **C4 nível 1** (quem usa o sistema: cliente, operador, entregador, operadora de pagamento) |
| **2** | Arquitetura | **C4 nível 2**: os 6 serviços, em que linguagem, quais rodam como aplicação e quais são "nuvem" (tabela abaixo) |
| **3** | Comunicação | REST na borda, RabbitMQ entre os serviços, saga do pedido, outbox/inbox, DLQ, o que acontece quando algo falha |
| **4** | Demonstração | cria o pedido, conduz o Grafana, chama o grande final e depois abre o QR code |
| **5** | Entregador | espera fora da sala com o celular; chega no momento combinado; explica o GPS e a comunicação |

### O que a pessoa 2 mostra (cada coisa onde roda)

| O quê | Quantos | Onde roda |
|---|---|---|
| Serviços de negócio: **pedidos**, **estoque** (Java), **pagamento** (2 réplicas), **entregas**, **auth** (TypeScript) | 5 (6 containers) | aplicação, em containers |
| **Gateway de pagamento** (faz o papel da operadora externa) | 1 | aplicação, mas tratado como sistema de fora |
| **RabbitMQ**, **Postgres** (um por serviço), **Redis** | 1 + 4 + 1 | infraestrutura, em containers |
| **Secrets Manager**, **S3** (rotas dos pedidos), **DynamoDB** (visão de consulta) | 3 | **nuvem** (AWS, simulada localmente pelo MiniStack e criada por Terraform) |
| **Grafana, Tempo, Prometheus, Loki** | 1 | observabilidade |
| **Traccar Client** (GPS) e **Cloudflare Tunnel** | | celular e rede |

Como se comunicam (pessoa 3): o cliente fala com o sistema por **HTTP (REST)**; os serviços falam entre si por **mensagens no RabbitMQ** (assíncrono, sem esperar um pelo outro); o gateway de pagamento é chamado por **HTTP**; o GPS chega por **HTTP** e o mapa recebe por **WebSocket**.

## Linha do tempo

| Quando | Quem | O que acontece |
|---|---|---|
| 0:00 | 1 | Abertura e C4 nível 1 |
| 2:00 | 2 | C4 nível 2: serviços, onde roda cada um |
| 5:00 | 3 | Comunicação, saga, outbox/inbox, DLQ |
| 8:00 | 4 | **Pedido de verdade.** No painel: clica no destino (a porta da sala) → escolhe o entregador → **Criar pedido**. Mostra o `202` na hora e o pedido andando. **Lá fora o celular do colega recebe o aviso** e ele começa a vir |
| 9:00 | 4 | Grafana: abre o pedido na tabela "O caminho do pedido" (pedidos → estoque → pagamento → gateway → entregas, com o tempo de cada um). O marcador 🛵 vem andando no mapa do painel |
| 12:00 | 4 | "Alguém pediu um pedido?" **A pessoa 5 entra na sala:** "Aqui que pediram um pedido?" O sistema marca **ENTREGUE** sozinho (menos de 50 m do destino) ou ele toca em **Confirmar entrega** |
| 13:00 | 5 | Explica o GPS: o app Traccar manda a posição a cada 3 s → túnel → serviço de entregas → Redis → WebSocket → mapa. Fala da latência do 4G e da conexão com o sistema (PWA, aviso no Telegram) |
| 15:00 | 4 | **QR code.** Repõe o estoque e abre o telão com o QR. Um botão só: **Quero um pedido!** |
| 15:30 | 2 | Narra o Grafana enquanto a plateia pede: pessoas que entraram, pedidos por minuto, tempo do pagamento, "Unidades restantes" caindo, o mapa de serviços |
| 18:00 | todos | Quando as unidades acabam: **"Sem sucesso"** sobe sem o estoque ficar negativo. É o cenário F5 acontecendo ao vivo |
| 19:00 | todos | Perguntas. Se o professor pedir uma falha (F1 a F8), rode o script e mostre no **Detalhes técnicos** |

Se a apresentação for mais curta, corte o C4 nível 1 e a falha extra. O que não se corta: o pedido, a chegada e o QR.

## Melhorias sobre a ideia original (e por quê)

1. **Crie o pedido cedo, não no fim.** O colega precisa de tempo para chegar. Crie o pedido quando a pessoa 3 estiver terminando (8:00) e deixe o marcador vir andando enquanto a pessoa 4 mostra o Grafana. Isso preenche o tempo e cria suspense.
2. **Defina o destino na porta da sala, mas confie no botão.** O GPS dentro de prédio erra 10 a 30 m. A conclusão automática vale a menos de 50 m. Se não disparar, o colega toca em **Confirmar entrega**: fica igualmente bom na plateia.
3. **O colega espera a 200 m ou mais** (outro corredor ou prédio), para o marcador *andar* de verdade antes de chegar. Se ele ficar perto demais, o pedido vira `ENTREGUE` antes da hora.
4. **Estoque diferente para cada momento.** Com 10 unidades, o pedido principal usa 1 e sobram 9. Antes do QR, rode `./scripts/reset-estoque.sh 25`: 25 unidades fazem uma turma de 40 pessoas ver sucesso para a maioria e "acabaram" para o resto, o que mostra que o sistema não vende além do estoque.
5. **O QR em tela cheia, com a URL em texto embaixo** (alguns celulares não leem o QR da tela). Use o **Modo telão** do painel.
6. **Grafana em tela cheia no telão** com o endereço `http://localhost:3000/d/apresentacao/apresentacao?kiosk`. Mostre o painel do operador e o Grafana em duas abas, e troque entre elas.
7. **Quem narra o Grafana não é quem opera.** A pessoa 4 mexe nas telas e a pessoa 2 explica o que aparece. Ninguém precisa fazer as duas coisas.
8. **Mostre o vermelho de propósito.** Com a turma pedindo, ligue uma taxa de falha no gateway (`GATEWAY_TAXA_FALHA=30` no `.env` e `docker compose up -d gateway-pagamento`). Cerca de 3 em cada 10 pedidos passam a ser recusados: a tabela mostra "Recusado", o caminho do pedido mostra em vermelho onde falhou e o mapa de serviços ganha um anel vermelho no pagamento. Depois volte para `0` e aplique de novo. Ensaie isso: é a parte que mais impressiona.
9. **Plano B pronto e ensaiado** (veja abaixo): se o GPS real falhar, o simulador reproduz a rota do ensaio com o device do colega e a plateia não percebe a diferença.

## Antes de começar (30 min antes)

- [ ] Notebook na tomada. `docker compose up -d` e `docker compose --profile tunnel up -d`; `docker compose ps` com tudo `healthy`.
- [ ] `./scripts/tunnel-url.sh` → configure a URL no Traccar e abra o painel **pela URL do túnel**. **Não reinicie o túnel daqui para frente.**
- [ ] `./scripts/reset-estoque.sh` (10 unidades) e o gateway sem falha e sem atraso (`GATEWAY_TAXA_FALHA=0`, `GATEWAY_LATENCIA_MS=0`).
- [ ] Colega com o app instalado, **Disponível**, com o marcador aparecendo no painel e "última posição há X s" baixo.
- [ ] Pedido de teste até `EM_ENTREGA`: confira que o aviso chegou e conclua pelo botão. Depois, `./scripts/reset-estoque.sh` de novo.
- [ ] Faça um pedido pelo QR para conferir: aparece no Grafana (espere ~20 s).
- [ ] Abas: painel (pela URL do túnel), Grafana (Apresentação), um terminal na pasta do projeto.
- [ ] Combinem o sinal para o colega entrar e uma mensagem de "pausa o Traccar" para o plano B.

## Ensaio (até 25/11)

- [ ] Fazer o percurso real com o sistema completo, do pedido até `ENTREGUE`, no lugar da apresentação.
- [ ] Baixar a rota do ensaio (`GET /api/entregas/{pedidoId}/rota` ou o arquivo no S3) e salvar em `simulador/rotas/ensaio.geojson`. Ela é o plano B.
- [ ] Testar o túnel na rede da faculdade (ele sai pela porta 7844). Se bloquear, use o roteador do celular no notebook.
- [ ] Testar com a turma de verdade (ou uns 20 celulares) o QR com o Wi-Fi e com o 4G.
- [ ] Rodar `./scripts/falhas/todos.sh` no notebook da apresentação: tudo `PASSOU`.

## Se algo der errado

| Problema | Faça |
|---|---|
| Pedido principal não chega a `EM_ENTREGA` | conferir se o colega está **Disponível** e criar outro pedido escolhendo-o |
| Marcador parado por mais de 30 s | mandar a mensagem combinada, pausar o Traccar e rodar a rota do ensaio (comando abaixo) |
| A chegada não dispara sozinha | o colega toca em **Confirmar entrega** |
| Túnel ou rede caem antes de começar | roteador do celular no notebook; se não resolver, demonstração com o simulador e sem QR |
| Telegram não chega | mostrar a mensagem em `docker compose logs entregas` e seguir |
| Um serviço cai | `docker compose restart <serviço>` e use a favor: as mensagens esperaram na fila, nada se perdeu |
| A turma esgotou o estoque antes da hora | `./scripts/reset-estoque.sh 25` |
| O pedido não aparece na tabela do Grafana | espere ~20 s e confira o período (canto superior direito) |

```bash
docker compose --profile sim run --rm simulador rota \
  --arquivo /rotas/ensaio.geojson --device <ENTREGADOR1_DEVICE_ID> --velocidade 40
```

No telão, a reprodução é idêntica a uma posição real.

**Segurança:** quem pilota não mexe no celular. O celular fica no suporte, com o Traccar rodando e o Google Maps aberto, e o pedido é lido antes de sair. Capacete e respeito ao trânsito: nenhuma demonstração vale um risco.
