package delivery.pedidos;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import org.springframework.stereotype.Component;

/** delivery_pedidos_transicoes_total{status}: quantas vezes cada status foi alcançado. */
@Component
public class PedidosMetricas {
    private static final AttributeKey<String> STATUS = AttributeKey.stringKey("status");
    private final LongCounter transicoes = GlobalOpenTelemetry.getMeter("delivery.pedidos")
            .counterBuilder("delivery_pedidos_transicoes_total")
            .setDescription("Transições de status dos pedidos")
            .build();

    public void transicao(String status) {
        transicoes.add(1, Attributes.of(STATUS, status));
    }
}
