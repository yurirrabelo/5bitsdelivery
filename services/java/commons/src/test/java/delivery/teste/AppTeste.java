package delivery.teste;

import delivery.commons.Envelope;
import delivery.commons.ManipuladorMensagem;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;

/** Aplicação mínima para provar que a commons se liga sozinha ao Spring (auto-configuração). */
@SpringBootApplication
public class AppTeste {
    public static final AtomicInteger CHAMADAS = new AtomicInteger();

    @Bean
    ManipuladorMensagem manipuladorReservar(JdbcTemplate jdbc) {
        return new ManipuladorMensagem() {
            @Override
            public String tipo() {
                return "estoque.reservar";
            }

            @Override
            public void tratar(Envelope e) {
                CHAMADAS.incrementAndGet();
                jdbc.update("INSERT INTO efeitos (message_id) VALUES (?)", UUID.fromString(e.messageId()));
            }
        };
    }
}
