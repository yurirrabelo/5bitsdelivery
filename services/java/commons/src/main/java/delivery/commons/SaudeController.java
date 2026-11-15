package delivery.commons;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /health: 200 {"status":"ok"} ou 503 se banco ou broker estiverem fora (ou o consumidor segurando mensagem). */
@RestController
public class SaudeController {
    private final JdbcTemplate jdbc;
    private final RabbitTemplate rabbit;
    private final EstadoSaude estado;

    public SaudeController(JdbcTemplate jdbc, RabbitTemplate rabbit, EstadoSaude estado) {
        this.jdbc = jdbc;
        this.rabbit = rabbit;
        this.estado = estado;
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> saude() {
        List<String> falhas = new ArrayList<>();
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
        } catch (Exception e) {
            falhas.add("banco");
        }
        try {
            rabbit.execute(canal -> canal.isOpen());
        } catch (Exception e) {
            falhas.add("broker");
        }
        if (estado.segurando()) falhas.add("consumidor segurando mensagem");

        Map<String, Object> corpo = new LinkedHashMap<>();
        if (falhas.isEmpty()) {
            corpo.put("status", "ok");
            return ResponseEntity.ok(corpo);
        }
        corpo.put("status", "indisponivel");
        corpo.put("falhas", falhas);
        return ResponseEntity.status(503).body(corpo);
    }
}
