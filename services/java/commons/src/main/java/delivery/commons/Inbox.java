package delivery.commons;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/** Registro das mensagens já processadas (idempotência do consumidor). */
public class Inbox {
    private final JdbcTemplate jdbc;

    public Inbox(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Registra o messageId. Devolve false se já foi processada (duplicada).
     * Chame na MESMA transação do efeito: se o efeito falhar, o registro também some.
     */
    public boolean registrar(Envelope envelope) {
        return jdbc.update(
                        "INSERT INTO mensagens_processadas (message_id, type) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING",
                        UUID.fromString(envelope.messageId()),
                        envelope.type())
                == 1;
    }
}
