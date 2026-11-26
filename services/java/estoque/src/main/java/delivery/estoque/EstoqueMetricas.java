package delivery.estoque;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** delivery_estoque_unidades{estado, tipo}: disponivel, reservado e vendido de cada grupo (normal e cupom), lidos do banco a cada exportação. */
@Component
public class EstoqueMetricas {
    private static final Logger log = LoggerFactory.getLogger(EstoqueMetricas.class);
    private static final AttributeKey<String> ESTADO = AttributeKey.stringKey("estado");
    private static final AttributeKey<String> TIPO = AttributeKey.stringKey("tipo");

    public EstoqueMetricas(JdbcTemplate jdbc) {
        GlobalOpenTelemetry.getMeter("delivery.estoque")
                .gaugeBuilder("delivery_estoque_unidades")
                .ofLongs()
                .setDescription("Unidades do item por estado e por grupo (normal ou com cupom)")
                .buildWithCallback(m -> {
                    try {
                        List<Map<String, Object>> linhas = jdbc.queryForList(
                                "SELECT produto_id, disponivel, reservado, vendido FROM estoque");
                        for (Map<String, Object> l : linhas) {
                            String tipo = ((Number) l.get("produto_id")).intValue() == SementeEstoque.PRODUTO_CUPOM ? "cupom" : "normal";
                            for (String estado : new String[] {"disponivel", "reservado", "vendido"}) {
                                m.record(((Number) l.get(estado)).longValue(), Attributes.of(ESTADO, estado, TIPO, tipo));
                            }
                        }
                    } catch (Exception e) {
                        log.debug("métrica do estoque: banco indisponível ({})", e.toString());
                    }
                });
    }
}
