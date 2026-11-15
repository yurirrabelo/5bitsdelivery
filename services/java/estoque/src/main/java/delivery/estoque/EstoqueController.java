package delivery.estoque;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class EstoqueController {
    private final JdbcTemplate jdbc;

    public EstoqueController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Qualquer usuário autenticado pode ver o contador da promoção. */
    @GetMapping("/api/estoque")
    public Map<String, Object> estoque(@RequestHeader(value = "X-User-Id", required = false) String userId) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        Map<String, Object> l = jdbc.queryForMap(
                "SELECT nome, total, disponivel, reservado, vendido FROM estoque WHERE produto_id = ?", SementeEstoque.PRODUTO);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("produto", l.get("nome"));
        m.put("total", l.get("total"));
        m.put("disponivel", l.get("disponivel"));
        m.put("reservado", l.get("reservado"));
        m.put("vendido", l.get("vendido"));
        return m;
    }
}
