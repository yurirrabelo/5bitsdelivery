package delivery.estoque;

import delivery.commons.Envelope;
import delivery.commons.ManipuladorMensagem;
import delivery.commons.Outbox;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Regras do estoque. Há dois grupos de itens: os com cupom (produto 2) e os normais (produto 1). A reserva é um UPDATE
 * condicional: o banco serializa a disputa pela linha do grupo, então não existe venda dupla, nem com réplicas.
 * Cada método roda na transação da inbox.
 */
@Configuration
public class FluxoEstoque {
    private final JdbcTemplate jdbc;
    private final Outbox outbox;

    public FluxoEstoque(JdbcTemplate jdbc, Outbox outbox) {
        this.jdbc = jdbc;
        this.outbox = outbox;
    }

    @Bean
    ManipuladorMensagem estoqueReservar() {
        return ManipuladorMensagem.de("estoque.reservar", this::reservar);
    }

    @Bean
    ManipuladorMensagem pedidoConfirmado() {
        return ManipuladorMensagem.de("pedido.confirmado", this::confirmar);
    }

    @Bean
    ManipuladorMensagem pedidoCancelado() {
        return ManipuladorMensagem.de("pedido.cancelado", this::liberar);
    }

    /**
     * Reserva uma unidade para o pedido e responde estoque.reservado ou estoque.esgotado. O pedido com cupom (campo cupom
     * do comando) leva um item com cupom; o pedido sem cupom leva um item normal. Os dois grupos esgotam separados.
     */
    void reservar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        boolean cupom = e.payload() != null && e.payload().path("cupom").asBoolean(false);
        int produto = cupom ? SementeEstoque.PRODUTO_CUPOM : SementeEstoque.PRODUTO;
        Map<String, Object> payload = Map.of("pedidoId", pedidoId);

        // reservas(pedido_id PK) impede reservar duas vezes para o mesmo pedido
        int nova = jdbc.update(
                "INSERT INTO reservas (pedido_id, produto_id, status) VALUES (?, ?, 'RESERVADA') ON CONFLICT (pedido_id) DO NOTHING",
                pedidoId, produto);
        if (nova == 0) {
            // comando repetido com outro messageId: não consome outra unidade, só repete a resposta
            String status = jdbc.queryForObject("SELECT status FROM reservas WHERE pedido_id = ?", String.class, pedidoId);
            if (!"LIBERADA".equals(status)) outbox.publicar("estoque.reservado", e.correlationId(), payload, null);
            return;
        }

        int reservou = jdbc.update(
                "UPDATE estoque SET disponivel = disponivel - 1, reservado = reservado + 1 WHERE produto_id = ? AND disponivel > 0",
                produto);
        if (reservou == 1) {
            outbox.publicar("estoque.reservado", e.correlationId(), payload, null);
        } else {
            jdbc.update("DELETE FROM reservas WHERE pedido_id = ?", pedidoId); // não houve reserva
            // vermelho no Grafana: foi aqui que acabou
            Span.current().setStatus(StatusCode.ERROR, cupom ? "itens com cupom esgotados" : "itens esgotados");
            outbox.publicar("estoque.esgotado", e.correlationId(), payload, null);
        }
    }

    /** pedido.confirmado: a reserva vira venda (no mesmo grupo de onde a unidade saiu). */
    void confirmar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        List<Integer> produto = jdbc.queryForList(
                "UPDATE reservas SET status = 'CONFIRMADA', atualizado_em = now() WHERE pedido_id = ? AND status = 'RESERVADA' RETURNING produto_id",
                Integer.class, pedidoId);
        if (produto.size() == 1) {
            jdbc.update("UPDATE estoque SET reservado = reservado - 1, vendido = vendido + 1 WHERE produto_id = ?", produto.get(0));
        }
    }

    /** pedido.cancelado: a unidade volta ao grupo de onde saiu (só uma vez, mesmo que a mensagem se repita). */
    void liberar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        List<Integer> produto = jdbc.queryForList(
                "UPDATE reservas SET status = 'LIBERADA', atualizado_em = now() WHERE pedido_id = ? AND status = 'RESERVADA' RETURNING produto_id",
                Integer.class, pedidoId);
        if (produto.size() == 1) {
            jdbc.update("UPDATE estoque SET reservado = reservado - 1, disponivel = disponivel + 1 WHERE produto_id = ?", produto.get(0));
        }
    }
}
