package delivery.estoque;

import delivery.commons.Envelope;
import delivery.commons.ManipuladorMensagem;
import delivery.commons.Outbox;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Regras do estoque. A reserva é um UPDATE condicional: o banco serializa a disputa pela linha do produto,
 * então não existe venda dupla, nem com réplicas. Cada método roda na transação da inbox.
 */
@Configuration
public class FluxoEstoque {
    private static final int PRODUTO = SementeEstoque.PRODUTO;

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

    /** Reserva uma unidade para o pedido e responde estoque.reservado ou estoque.esgotado. */
    void reservar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        Map<String, Object> payload = Map.of("pedidoId", pedidoId);

        // reservas(pedido_id PK) impede reservar duas vezes para o mesmo pedido
        int nova = jdbc.update(
                "INSERT INTO reservas (pedido_id, produto_id, status) VALUES (?, ?, 'RESERVADA') ON CONFLICT (pedido_id) DO NOTHING",
                pedidoId, PRODUTO);
        if (nova == 0) {
            // comando repetido com outro messageId: não consome outra unidade, só repete a resposta
            String status = jdbc.queryForObject("SELECT status FROM reservas WHERE pedido_id = ?", String.class, pedidoId);
            if (!"LIBERADA".equals(status)) outbox.publicar("estoque.reservado", e.correlationId(), payload, null);
            return;
        }

        int reservou = jdbc.update(
                "UPDATE estoque SET disponivel = disponivel - 1, reservado = reservado + 1 WHERE produto_id = ? AND disponivel > 0",
                PRODUTO);
        if (reservou == 1) {
            outbox.publicar("estoque.reservado", e.correlationId(), payload, null);
        } else {
            jdbc.update("DELETE FROM reservas WHERE pedido_id = ?", pedidoId); // não houve reserva
            Span.current().setStatus(StatusCode.ERROR, "estoque esgotado"); // vermelho no Grafana: foi aqui que acabou
            outbox.publicar("estoque.esgotado", e.correlationId(), payload, null);
        }
    }

    /** pedido.confirmado: a reserva vira venda. */
    void confirmar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        int n = jdbc.update(
                "UPDATE reservas SET status = 'CONFIRMADA', atualizado_em = now() WHERE pedido_id = ? AND status = 'RESERVADA'", pedidoId);
        if (n == 1) {
            jdbc.update("UPDATE estoque SET reservado = reservado - 1, vendido = vendido + 1 WHERE produto_id = ?", PRODUTO);
        }
    }

    /** pedido.cancelado: a unidade volta ao estoque (só uma vez, mesmo que a mensagem se repita). */
    void liberar(Envelope e) {
        long pedidoId = e.payloadLong("pedidoId");
        int n = jdbc.update(
                "UPDATE reservas SET status = 'LIBERADA', atualizado_em = now() WHERE pedido_id = ? AND status = 'RESERVADA'", pedidoId);
        if (n == 1) {
            jdbc.update("UPDATE estoque SET reservado = reservado - 1, disponivel = disponivel + 1 WHERE produto_id = ?", PRODUTO);
        }
    }
}
