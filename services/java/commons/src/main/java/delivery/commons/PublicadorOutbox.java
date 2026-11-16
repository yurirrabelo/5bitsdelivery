package delivery.commons;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.context.Scope;
import java.nio.charset.StandardCharsets;
import java.sql.Array;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.context.SmartLifecycle;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Lê as mensagens pendentes da outbox (FOR UPDATE SKIP LOCKED, funciona igual com réplicas), publica com
 * publisher confirm e marca como publicada. Com o broker fora do ar as mensagens esperam na tabela.
 */
public class PublicadorOutbox implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(PublicadorOutbox.class);

    private record Linha(long id, String payload, String traceparent) {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final RabbitTemplate rabbit;
    private final Metricas metricas;
    private final String exchange;
    private final int lote;
    private final long intervaloMs;

    private ScheduledExecutorService executor;
    private volatile boolean ativo;
    private long ultimaFalhaMs;
    private long ultimoAvisoMs;
    private long ultimaContagemMs;

    public PublicadorOutbox(
            JdbcTemplate jdbc,
            PlatformTransactionManager transacoes,
            RabbitTemplate rabbit,
            Metricas metricas,
            String exchange,
            int lote,
            long intervaloMs) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(transacoes);
        this.rabbit = rabbit;
        this.metricas = metricas;
        this.exchange = exchange;
        this.lote = lote;
        this.intervaloMs = intervaloMs;
    }

    @Override
    public void start() {
        ativo = true;
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "outbox-publicador");
            t.setDaemon(true);
            return t;
        });
        executor.scheduleWithFixedDelay(this::cicloSeguro, 0, intervaloMs, TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() {
        ativo = false;
        if (executor != null) executor.shutdownNow();
    }

    @Override
    public boolean isRunning() {
        return ativo;
    }

    private void cicloSeguro() {
        try {
            ciclo();
        } catch (Exception e) {
            avisar(e);
        }
    }

    /** Publica um lote. Devolve quantas mensagens saíram. Público para os testes. */
    public int ciclo() {
        long agora = System.currentTimeMillis();
        // depois de uma falha espera um pouco antes de tentar o broker de novo
        if (agora - ultimaFalhaMs < 1000) return 0;

        Integer publicadas = tx.execute(status -> {
            List<Linha> linhas = jdbc.query(
                    "SELECT id, payload::text AS payload, traceparent FROM outbox WHERE publicada_em IS NULL "
                            + "ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
                    (rs, i) -> new Linha(rs.getLong("id"), rs.getString("payload"), rs.getString("traceparent")),
                    lote);
            if (linhas.isEmpty()) return 0;
            List<Long> feitas = new ArrayList<>();
            try {
                rabbit.invoke(ops -> {
                    for (Linha l : linhas) {
                        publicarUma(ops, l);
                        feitas.add(l.id());
                    }
                    return null;
                });
            } catch (Exception e) {
                ultimaFalhaMs = System.currentTimeMillis();
                avisar(e); // marca só as que saíram; as demais ficam para o próximo ciclo
            }
            if (!feitas.isEmpty()) {
                jdbc.update(con -> {
                    var ps = con.prepareStatement("UPDATE outbox SET publicada_em = now() WHERE id = ANY (?)");
                    Array ids = con.createArrayOf("bigint", feitas.toArray());
                    ps.setArray(1, ids);
                    return ps;
                });
            }
            return feitas.size();
        });
        atualizarContagem();
        return publicadas == null ? 0 : publicadas;
    }

    private void publicarUma(org.springframework.amqp.rabbit.core.RabbitOperations ops, Linha l) {
        Envelope envelope = Json.MAPPER.readValue(l.payload(), Envelope.class);
        Span span = GlobalOpenTelemetry.getTracer("delivery.commons")
                .spanBuilder("outbox publicar")
                .setParent(Trace.contextoDe(l.traceparent()))
                .setSpanKind(SpanKind.PRODUCER)
                .startSpan();
        Long pedidoId = envelope.payloadLong("pedidoId");
        if (pedidoId != null) span.setAttribute("pedido.id", pedidoId);
        try (Scope ignored = span.makeCurrent()) {
            String traceparent = Trace.traceparentAtual();
            MessageProperties p = new MessageProperties();
            p.setContentType("application/json");
            p.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
            p.setMessageId(envelope.messageId());
            p.setCorrelationId(envelope.correlationId());
            p.setType(envelope.type());
            String tp = traceparent != null ? traceparent : l.traceparent();
            if (tp != null) p.setHeader("traceparent", tp);
            // JSON compacto (o jsonb do Postgres devolve o texto reformatado)
            byte[] corpo = Json.MAPPER.writeValueAsString(envelope).getBytes(StandardCharsets.UTF_8);
            ops.send(exchange, envelope.type(), new Message(corpo, p));
            ops.waitForConfirmsOrDie(5000);
        } finally {
            span.end();
        }
    }

    private void atualizarContagem() {
        long agora = System.currentTimeMillis();
        if (agora - ultimaContagemMs < 2000) return;
        ultimaContagemMs = agora;
        Long n = jdbc.queryForObject("SELECT count(*) FROM outbox WHERE publicada_em IS NULL", Long.class);
        metricas.definirOutboxPendentes(n == null ? 0 : n);
    }

    // No máximo um aviso a cada 5 s, para o log não encher com o broker fora do ar
    private void avisar(Exception e) {
        long agora = System.currentTimeMillis();
        if (agora - ultimoAvisoMs < 5000) return;
        ultimoAvisoMs = agora;
        log.warn("outbox: não consegui publicar; as mensagens esperam ({})", e.toString());
    }
}
