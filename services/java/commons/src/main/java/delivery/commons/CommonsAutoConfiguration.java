package delivery.commons;

import java.nio.file.Path;
import java.util.List;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Liga a commons ao Spring: basta o serviço ter a dependência. Para consumir mensagens, o serviço declara
 * @Component que implementam ManipuladorMensagem e define delivery.fila (ex.: ${FILA_ESTOQUE}).
 */
@AutoConfiguration(afterName = {
    "org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.DataSourceTransactionManagerAutoConfiguration",
    "org.springframework.boot.amqp.autoconfigure.RabbitAutoConfiguration",
    "org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration",
    "org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration",
    "org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration"
})
public class CommonsAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    ContratoValidador contratoValidador(@Value("${CONTRACTS_DIR:/app/contracts}") String dir) {
        return new ContratoValidador(Path.of(dir, "schemas"));
    }

    @Bean
    @ConditionalOnMissingBean
    Metricas metricas() {
        return new Metricas();
    }

    @Bean
    @ConditionalOnMissingBean
    EstadoSaude estadoSaude() {
        return new EstadoSaude();
    }

    @Bean
    @ConditionalOnMissingBean
    Outbox outbox(JdbcTemplate jdbc) {
        return new Outbox(jdbc);
    }

    @Bean
    @ConditionalOnMissingBean
    Inbox inbox(JdbcTemplate jdbc) {
        return new Inbox(jdbc);
    }

    @Bean
    @ConditionalOnMissingBean
    PublicadorOutbox publicadorOutbox(
            JdbcTemplate jdbc,
            PlatformTransactionManager transacoes,
            RabbitTemplate rabbit,
            Metricas metricas,
            @Value("${RABBITMQ_EXCHANGE}") String exchange,
            @Value("${delivery.outbox.lote:50}") int lote,
            @Value("${delivery.outbox.intervalo-ms:200}") long intervaloMs) {
        return new PublicadorOutbox(jdbc, transacoes, rabbit, metricas, exchange, lote, intervaloMs);
    }

    @Bean
    @ConditionalOnProperty(name = "delivery.fila")
    ConsumidorMensagens consumidorMensagens(
            ConnectionFactory conexoes,
            @Value("${delivery.fila}") String fila,
            List<ManipuladorMensagem> manipuladores,
            ContratoValidador validador,
            Inbox inbox,
            PlatformTransactionManager transacoes,
            EstadoSaude estado,
            Metricas metricas,
            @Value("${delivery.backoff-inicial-ms:500}") long backoffInicialMs,
            @Value("${delivery.backoff-max-ms:10000}") long backoffMaxMs) {
        return new ConsumidorMensagens(
                conexoes, fila, manipuladores, validador, inbox, transacoes, estado, metricas, backoffInicialMs, backoffMaxMs);
    }

    @Bean
    @ConditionalOnMissingBean
    SaudeController saudeController(JdbcTemplate jdbc, RabbitTemplate rabbit, EstadoSaude estado) {
        return new SaudeController(jdbc, rabbit, estado);
    }
}
