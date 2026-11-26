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
    private static final String[] CAMPOS = {"total", "disponivel", "reservado", "vendido"};

    private final JdbcTemplate jdbc;

    public EstoqueController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Qualquer usuário autenticado pode ver quantas unidades do item restam. Os números de cima são do item todo (os dois
     * grupos somados); "normal" e "cupom" mostram cada grupo.
     */
    @GetMapping("/api/estoque")
    public Map<String, Object> estoque(@RequestHeader(value = "X-User-Id", required = false) String userId) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        Map<String, Object> normal = grupo(SementeEstoque.PRODUTO);
        Map<String, Object> cupom = grupo(SementeEstoque.PRODUTO_CUPOM);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("produto", jdbc.queryForObject("SELECT nome FROM estoque WHERE produto_id = ?", String.class, SementeEstoque.PRODUTO));
        for (String campo : CAMPOS) {
            m.put(campo, ((Number) normal.get(campo)).intValue() + ((Number) cupom.get(campo)).intValue());
        }
        m.put("normal", normal);
        m.put("cupom", cupom);
        return m;
    }

    private Map<String, Object> grupo(int produto) {
        Map<String, Object> l = jdbc.queryForMap(
                "SELECT total, disponivel, reservado, vendido FROM estoque WHERE produto_id = ?", produto);
        Map<String, Object> g = new LinkedHashMap<>();
        for (String campo : CAMPOS) g.put(campo, l.get(campo));
        return g;
    }
}
