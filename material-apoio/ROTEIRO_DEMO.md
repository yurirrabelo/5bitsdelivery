# Roteiro da demo ao vivo

> Guarde este arquivo fora do repositório até a apresentação, para não estragar a surpresa.

A ordem importa: o pedido principal sai primeiro, porque reserva uma das unidades da promoção. Enquanto o colega anda de moto, a turma faz os pedidos pelo QR com as unidades que sobraram.

## Ensaio (até 25/11)

- [ ] Fazer o percurso real de moto com o sistema completo, do pedido até `ENTREGUE`.
- [ ] Escolher um destino a 5–8 minutos da faculdade. A turma precisa ver a moto andando, mas a apresentação não pode depender de uma viagem longa.
- [ ] Baixar a rota do ensaio (`GET /api/entregas/{pedidoId}/rota` ou o arquivo no S3) e salvar em `simulador/rotas/ensaio.geojson`. Ela é o plano B.
- [ ] Testar o plano B uma vez (comando no fim deste arquivo).
- [ ] Testar o túnel na rede da faculdade (ele sai pela porta 7844). Se bloquear, usar o roteador do celular no notebook.
- [ ] Rodar `./scripts/falhas/todos.sh` no notebook da apresentação: tudo PASSOU.
- [ ] Combinar com o colega uma mensagem de "pausa o Traccar", para o caso do plano B.

## No dia, 30 minutos antes

- [ ] Notebook na tomada. Subir tudo: `docker compose up -d` e `docker compose --profile tunnel up -d`.
- [ ] `docker compose ps`: tudo `healthy`.
- [ ] `./scripts/reset-estoque.sh` (10 unidades) e gateway sem falha e sem atraso.
- [ ] `./scripts/tunnel-url.sh` → configurar a URL no Traccar e na PWA do colega.
- [ ] Colega com status **Disponível** e o marcador dele aparecendo no painel.
- [ ] Pedido de teste até `EM_ENTREGA`, conferir que o Telegram chegou e concluir pelo botão. Depois, `./scripts/reset-estoque.sh` de novo.
- [ ] Abas abertas: painel pela URL do túnel (tela cheia no telão), Grafana no painel "Delivery ao vivo", RabbitMQ e um terminal na pasta do projeto.
- [ ] Celular do colega carregado e no suporte da moto, capacete, destino definido.
- [ ] **Não reiniciar o `cloudflared` daqui para frente.**

## Durante a apresentação (~12 min)

1. **Arquitetura (2 min).** Diagrama C4 de containers e o caminho das mensagens.
2. **O pedido principal (1 min).** "Agora vamos fazer um pedido de verdade." Clicar no destino, escolher o colega e criar. Mostrar o `202` e o pedido passando por reservado, pagamento e confirmado.
3. **A notificação.** O celular do colega vibra com o Telegram. Ele mostra para a turma e sai.
4. **Ao vivo (5–8 min).** Enquanto ele anda de moto pela cidade, o marcador anda no telão. Nesse tempo:
   - mostrar o QR code: a turma pede com as 9 unidades restantes e vê no celular quem conseguiu e quem pegou "esgotado";
   - ligar uma taxa de falha no gateway (`GATEWAY_TAXA_FALHA=30`) para alguém ver a compensação no próprio celular;
   - no Grafana: estoque zerando, filas, pagamentos e o trace de um pedido atravessando todos os serviços;
   - "última posição há X s", para falar de latência e rede móvel.
5. **A chegada.** O geofence marca `ENTREGUE` sozinho, o colega recebe a confirmação e o rastro completo fica no mapa.
6. **A falha que o professor escolher (F1 a F8).** Rodar o script correspondente e mostrar o resultado no Grafana e no `./scripts/estado.sh`. Na falha surpresa, consultar a tabela da seção 11.3 da especificação e dizer o que vai acontecer antes de executar.
7. **Bônus.** Trace de ponta a ponta, `recriar-infra.sh` e o que mais estiver pronto.
8. **Perguntas** enquanto o colega volta.

**Segurança:** quem pilota não mexe no celular. O celular fica no suporte, com o Traccar rodando sozinho e o Google Maps aberto; o pedido é lido antes de sair. Capacete e respeito às leis de trânsito, demo nenhuma vale um risco.

## Plano B

| Problema | Ação |
|---|---|
| Pedido principal não chega a `EM_ENTREGA` | conferir o status do colega no app e criar outro pedido escolhendo ele |
| Marcador parado por mais de 30 s | mandar a mensagem combinada para pausar o Traccar e rodar a rota do ensaio com o device do colega (comando abaixo) |
| Túnel ou rede caem antes de começar | roteador do celular no notebook; se não resolver, demo inteira com o simulador e sem QR |
| Telegram não chega | mostrar a mensagem em `docker compose logs entregas` e seguir |
| Um serviço cai | `docker compose restart <serviço>` e usar a favor: as mensagens esperaram na fila, nada se perdeu |
| Turma esgota o estoque antes da hora | `./scripts/reset-estoque.sh` |

```bash
docker compose --profile sim run --rm simulador rota \
  --arquivo /rotas/ensaio.geojson --device <ENTREGADOR1_DEVICE_ID> --velocidade 40
```

No telão, a reprodução é idêntica a uma posição real.
