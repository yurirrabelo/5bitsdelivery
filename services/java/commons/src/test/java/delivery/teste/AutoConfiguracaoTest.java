package delivery.teste;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import delivery.commons.Envelope;
import delivery.commons.Outbox;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Sobe uma aplicação Spring de verdade (Flyway, JDBC, RabbitMQ, commons) e confere a ponta a ponta:
 * outbox → RabbitMQ → consumidor → inbox → efeito, e o GET /health.
 */
@SpringBootTest(classes = AppTeste.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// fecha o contexto no fim: o publicador da outbox dele, se continuasse vivo, publicaria as linhas dos outros testes
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AutoConfiguracaoTest {
    static final String ID = UUID.randomUUID().toString().substring(0, 8);
    static final String EXCHANGE = "ex." + ID;
    static final String FILA = "q." + ID;

    static String env(String nome, String padrao) {
        String v = System.getenv(nome);
        return v == null || v.isBlank() ? padrao : v;
    }

    @DynamicPropertySource
    static void propriedades(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> env("TEST_PG_URL", "jdbc:postgresql://localhost:5432/teste"));
        r.add("spring.datasource.username", () -> env("TEST_PG_USER", "teste"));
        r.add("spring.datasource.password", () -> env("TEST_PG_PASSWORD", "teste"));
        r.add("spring.rabbitmq.addresses", () -> env("TEST_AMQP_URL", "amqp://teste:teste@localhost:5672"));
        r.add("spring.flyway.baseline-on-migrate", () -> "true");
        r.add("spring.flyway.baseline-version", () -> "0");
        r.add("spring.flyway.locations", () -> "classpath:db/commons");
        r.add("CONTRACTS_DIR", () -> env("CONTRACTS_DIR", "../../../contracts"));
        r.add("RABBITMQ_EXCHANGE", () -> EXCHANGE);
        r.add("delivery.fila", () -> FILA);
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired Outbox outbox;
    @Autowired PlatformTransactionManager transacoes;
    @Autowired RabbitTemplate rabbit;
    @Value("${local.server.port}") int porta;

    @Test
    void aCommonsSeLigaSozinhaEFazOCaminhoCompleto() throws Exception {
        jdbc.execute("CREATE TABLE IF NOT EXISTS efeitos (id SERIAL PRIMARY KEY, message_id UUID)");
        rabbit.execute(ch -> {
            ch.exchangeDeclare(EXCHANGE, "topic", true);
            ch.queueDeclare(FILA, true, false, false, Map.of("x-queue-type", "quorum"));
            ch.queueBind(FILA, EXCHANGE, "estoque.reservar");
            return null;
        });

        Envelope e = new TransactionTemplate(transacoes).execute(
                s -> outbox.publicar("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", 77), null));

        // o publicador da outbox (200 ms) e o consumidor rodam sozinhos, sem nenhum código do teste
        assertTrue(esperar(() -> contar("SELECT count(*) FROM efeitos WHERE message_id = '" + e.messageId() + "'") == 1));
        assertEquals(1, contar("SELECT count(*) FROM mensagens_processadas WHERE message_id = '" + e.messageId() + "'"));
        assertTrue(esperar(() -> contar("SELECT count(*) FROM outbox WHERE publicada_em IS NULL") == 0));

        HttpResponse<String> saude = HttpClient.newHttpClient()
                .send(HttpRequest.newBuilder(URI.create("http://localhost:" + porta + "/health")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, saude.statusCode());
        assertTrue(saude.body().contains("\"status\":\"ok\""), saude.body());

        rabbit.execute(ch -> {
            ch.queueDelete(FILA);
            return null;
        });
    }

    private int contar(String sql) {
        return jdbc.queryForObject(sql, Integer.class);
    }

    private static boolean esperar(BooleanSupplier condicao) {
        long limite = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < limite) {
            if (condicao.getAsBoolean()) return true;
            try {
                Thread.sleep(100);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
        }
        return condicao.getAsBoolean();
    }
}
