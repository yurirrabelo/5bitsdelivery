package delivery.commons;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Grava a mensagem a publicar na tabela outbox. Chame de dentro da transação do efeito
 * (@Transactional): o efeito e a mensagem são confirmados ou desfeitos juntos.
 */
public class Outbox {
    private final JdbcTemplate jdbc;

    public Outbox(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * O traceparent do trace ativo vai junto, para o trace não quebrar na outbox. Sem trace ativo
     * (ex.: o agendador do prazo), usa o traceparentPadrao (o guardado no pedido).
     */
    public Envelope publicar(String type, String correlationId, Object payload, String traceparentPadrao) {
        return publicar(type, correlationId, 1, payload, traceparentPadrao);
    }

    /** Publica uma versão específica do contrato (ex.: pedido.confirmado v2). */
    public Envelope publicar(String type, String correlationId, int version, Object payload, String traceparentPadrao) {
        Envelope envelope = Envelope.novo(type, correlationId, payload, version);
        gravar(envelope, traceparentPadrao);
        return envelope;
    }

    public void gravar(Envelope envelope, String traceparentPadrao) {
        String traceparent = Trace.traceparentAtual();
        jdbc.update(
                "INSERT INTO outbox (message_id, type, payload, traceparent) VALUES (?, ?, ?::jsonb, ?)",
                UUID.fromString(envelope.messageId()),
                envelope.type(),
                Json.MAPPER.writeValueAsString(envelope),
                traceparent != null ? traceparent : traceparentPadrao);
    }
}
