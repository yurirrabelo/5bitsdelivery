package delivery.estoque;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** delivery_estoque_unidades{estado}: disponivel, reservado e vendido, lidos do banco a cada exportação. */
@Component
public class EstoqueMetricas {
    private static final Logger log = LoggerFactory.getLogger(EstoqueMetricas.class);
    private static final AttributeKey<String> ESTADO = AttributeKey.stringKey("estado");

    public EstoqueMetricas(JdbcTemplate jdbc) {
        GlobalOpenTelemetry.getMeter("delivery.estoque")
                .gaugeBuilder("delivery_estoque_unidades")
                .ofLongs()
                .setDescription("Unidades da promoção por estado")
                .buildWithCallback(m -> {
                    try {
                        Map<String, Object> l = jdbc.queryForMap(
                                "SELECT disponivel, reservado, vendido FROM estoque WHERE produto_id = ?", SementeEstoque.PRODUTO);
                        for (String estado : new String[] {"disponivel", "reservado", "vendido"}) {
                            m.record(((Number) l.get(estado)).longValue(), Attributes.of(ESTADO, estado));
                        }
                    } catch (Exception e) {
                        log.debug("métrica do estoque: banco indisponível ({})", e.toString());
                    }
                });
    }
}
