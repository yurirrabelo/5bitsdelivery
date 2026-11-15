package delivery.commons;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;
import java.util.concurrent.atomic.AtomicLong;

/** Métricas de negócio da commons. Com o agente do OpenTelemetry elas vão para o Prometheus. */
public class Metricas {
    private static final AttributeKey<String> TYPE = AttributeKey.stringKey("type");
    private static final AttributeKey<String> RESULTADO = AttributeKey.stringKey("resultado");

    private final LongCounter mensagens;
    private final AtomicLong outboxPendentes = new AtomicLong();

    public Metricas() {
        Meter meter = GlobalOpenTelemetry.getMeter("delivery.commons");
        mensagens = meter.counterBuilder("delivery_mensagens_total")
                .setDescription("Mensagens consumidas, por tipo e resultado")
                .build();
        meter.gaugeBuilder("delivery_outbox_pendentes")
                .ofLongs()
                .setDescription("Mensagens esperando na outbox para serem publicadas")
                .buildWithCallback(m -> m.record(outboxPendentes.get()));
    }

    /** resultado: processada | duplicada | erro */
    public void mensagem(String type, String resultado) {
        mensagens.add(1, Attributes.of(TYPE, type, RESULTADO, resultado));
    }

    public void definirOutboxPendentes(long n) {
        outboxPendentes.set(n);
    }
}
