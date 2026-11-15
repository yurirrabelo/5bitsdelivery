package delivery.commons;

import java.net.URI;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory.ConfirmType;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Ambiente dos testes: Postgres e RabbitMQ descartáveis (docker-compose.test.yml). */
final class Ambiente {
    static final String PG_URL = env("TEST_PG_URL", "jdbc:postgresql://localhost:5432/teste");
    static final String PG_USER = env("TEST_PG_USER", "teste");
    static final String PG_PASSWORD = env("TEST_PG_PASSWORD", "teste");
    static final String AMQP_URL = env("TEST_AMQP_URL", "amqp://teste:teste@localhost:5672");

    private Ambiente() {}

    static String env(String nome, String padrao) {
        String v = System.getenv(nome);
        return v == null || v.isBlank() ? padrao : v;
    }

    static Path dirContratos() {
        return Path.of(env("CONTRACTS_DIR", "../../../contracts"), "schemas");
    }

    static DataSource dataSource() {
        return new DriverManagerDataSource(PG_URL, PG_USER, PG_PASSWORD);
    }

    /** Aplica a migração da commons. O baseline permite um banco que o teste TypeScript já tenha usado. */
    static void migrar(DataSource ds) {
        Flyway.configure()
                .dataSource(ds)
                .locations("classpath:db/commons")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .load()
                .migrate();
    }

    static CachingConnectionFactory conexoes(String url) {
        CachingConnectionFactory cf = new CachingConnectionFactory(URI.create(url));
        cf.setPublisherConfirmType(ConfirmType.CORRELATED);
        cf.setConnectionTimeout(2000);
        return cf;
    }

    static boolean esperar(BooleanSupplier condicao, long ms) {
        long limite = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < limite) {
            if (condicao.getAsBoolean()) return true;
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return condicao.getAsBoolean();
    }

    /** Exchange topic + fila quorum com DLX e limite de entregas, como o Terraform cria no sistema real. */
    record Topologia(String exchange, String dlx, String fila, String dlq, RabbitTemplate rabbit) {
        static Topologia criar(RabbitTemplate rabbit, int limiteEntregas, String... tipos) {
            String id = UUID.randomUUID().toString().substring(0, 8);
            Topologia t = new Topologia("ex." + id, "dlx." + id, "q." + id, "q." + id + ".dlq", rabbit);
            rabbit.execute(ch -> {
                ch.exchangeDeclare(t.exchange, "topic", true);
                ch.exchangeDeclare(t.dlx, "direct", true);
                ch.queueDeclare(t.dlq, true, false, false, Map.of("x-queue-type", "quorum"));
                ch.queueBind(t.dlq, t.dlx, t.fila);
                ch.queueDeclare(
                        t.fila,
                        true,
                        false,
                        false,
                        Map.of(
                                "x-queue-type", "quorum",
                                "x-dead-letter-exchange", t.dlx,
                                "x-dead-letter-routing-key", t.fila,
                                "x-delivery-limit", limiteEntregas));
                for (String tipo : tipos) ch.queueBind(t.fila, t.exchange, tipo);
                return null;
            });
            return t;
        }

        void publicar(String tipo, String corpo) {
            rabbit.execute(ch -> {
                ch.basicPublish(exchange, tipo, new com.rabbitmq.client.AMQP.BasicProperties.Builder()
                        .contentType("application/json")
                        .deliveryMode(2)
                        .build(), corpo.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                return null;
            });
        }

        long tamanho(String nomeFila) {
            Long n = rabbit.execute(ch -> ch.messageCount(nomeFila));
            return n == null ? 0 : n;
        }

        void remover() {
            rabbit.execute(ch -> {
                ch.queueDelete(fila);
                ch.queueDelete(dlq);
                return null;
            });
        }
    }
}
