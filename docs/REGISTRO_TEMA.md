# Registro do tema — Sistemas Distribuídos

**Tema:** 5Bits Delivery: delivery com promoção relâmpago e rastreamento do entregador

**Integrantes:** _(preencher)_

**Linguagem de cada serviço** (duas linguagens, conforme a alteração do requisito combinada com o professor):

| Serviço | Linguagem |
|---|---|
| pedidos | Java (Spring Boot) |
| estoque | Java (Spring Boot) |
| pagamento | TypeScript (Node.js) |
| entregas | TypeScript (Node.js) |
| auth | TypeScript (Node.js) |
| gateway de pagamento (dependência simulada) | TypeScript (Node.js) |

**Nuvem:** AWS emulada com o MiniStack (Secrets Manager e S3), criada por Terraform. Mensageria com RabbitMQ em container próprio.

**Fluxo principal:** o cliente faz um pedido com o cupom de uma promoção de poucas unidades (ou um pedido normal, sem cupom) e recebe na hora o número do pedido (`202 Accepted`). O serviço de pedidos coordena a operação: no pedido com cupom, pede ao estoque a reserva de uma unidade e, com ela reservada, pede ao serviço de pagamento a cobrança num gateway externo. Aprovada a cobrança, o pedido é confirmado e oferecido aos entregadores: o primeiro que aceita pelo celular leva e é acompanhado no mapa, pelo GPS, até o endereço do cliente. As unidades da promoção são o recurso escasso: sob carga, nenhuma é vendida duas vezes.

- **Transação distribuída com compensação:** a reserva no estoque e a cobrança no pagamento. Se a cobrança falha ou não responde dentro do prazo, o pedido é cancelado e a unidade volta ao estoque; se a aprovação chega depois do prazo, o pagamento é estornado.
- **Dependência lenta ou instável:** o gateway de pagamento, simulado pelo grupo, com latência e taxa de falha configuráveis por variável de ambiente.
- **Evento com vários interessados:** `pedido.confirmado`, publicado uma vez e consumido pelo estoque (que transforma a reserva em venda) e pelo serviço de entregas (que cria a entrega e a oferece aos entregadores).
