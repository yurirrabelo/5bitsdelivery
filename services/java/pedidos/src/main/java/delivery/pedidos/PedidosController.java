package delivery.pedidos;

import io.opentelemetry.api.trace.Span;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * API de pedidos. A identidade chega nos headers X-User-* que o Nginx sempre sobrescreve
 * (o serviço confia só neles; nunca em dados do corpo).
 */
@RestController
public class PedidosController {
    /** destino: onde entregar. entregadorPreferidoId: só a gestão pode escolher o entregador. */
    public record CriarPedido(PedidoServico.Destino destino, Integer entregadorPreferidoId) {}

    private final PedidoServico servico;
    private final PedidoRepositorio repo;
    private final RegrasPedidos regras;

    public PedidosController(PedidoServico servico, PedidoRepositorio repo, RegrasPedidos regras) {
        this.servico = servico;
        this.repo = repo;
        this.regras = regras;
    }

    @GetMapping("/api/pedidos/config")
    public Map<String, Object> config() {
        return Map.of(
                "origem", Map.of("nome", regras.origemNome, "lat", regras.origemLat, "lon", regras.origemLon),
                "item", Map.of("nome", regras.itemNome));
    }

    /** Responde 202 na hora: o resto acontece por mensagens. O cliente acompanha por GET /api/pedidos/{id}. */
    @PostMapping("/api/pedidos")
    public ResponseEntity<Map<String, Object>> criar(
            @RequestHeader(value = "X-User-Id", required = false) String userId,
            @RequestHeader(value = "X-User-Role", required = false) String role,
            @RequestBody(required = false) CriarPedido corpo) {
        exigirLogin(userId, role);
        long id;
        try {
            if ("operador".equals(role)) {
                // a gestão cria o pedido à mão, sempre com o endereço (e, se quiser, escolhe o entregador)
                PedidoServico.Destino d = corpo == null ? null : corpo.destino();
                validarDestino(d);
                id = servico.criar(userId, false, d, corpo.entregadorPreferidoId());
            } else if ("cliente".equals(role)) {
                // O cliente manda onde quer receber (o GPS do celular dele). Com endereço o pedido vira uma entrega que um
                // entregador aceita; sem endereço, termina em CONFIRMADO. O cliente nunca escolhe o entregador.
                PedidoServico.Destino d = corpo == null ? null : corpo.destino();
                if (d != null) validarDestino(d);
                id = servico.criar(userId, true, d, null);
            } else {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "papel sem permissão para criar pedido");
            }
        } catch (PedidoServico.LimiteExcedidoException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage());
        }
        Span.current().setAttribute("pedido.id", id); // o trace do pedido começa nesta requisição
        String statusUrl = "/api/pedidos/" + id;
        return ResponseEntity.accepted()
                .header("Location", statusUrl)
                .body(Map.of("id", id, "status", "RECEBIDO", "statusUrl", statusUrl));
    }

    @GetMapping("/api/pedidos/{id}")
    public Map<String, Object> buscar(
            @PathVariable long id,
            @RequestHeader(value = "X-User-Id", required = false) String userId,
            @RequestHeader(value = "X-User-Role", required = false) String role,
            @RequestHeader(value = "X-Entregador-Id", required = false) String entregadorId) {
        return json(visivel(id, userId, role, entregadorId));
    }

    @GetMapping("/api/pedidos/{id}/historico")
    public List<PedidoRepositorio.Transicao> historico(
            @PathVariable long id,
            @RequestHeader(value = "X-User-Id", required = false) String userId,
            @RequestHeader(value = "X-User-Role", required = false) String role,
            @RequestHeader(value = "X-Entregador-Id", required = false) String entregadorId) {
        visivel(id, userId, role, entregadorId);
        return repo.historico(id);
    }

    /** Últimos pedidos, com número e status (só operador). */
    @GetMapping("/api/pedidos")
    public List<Map<String, Object>> listar(
            @RequestHeader(value = "X-User-Id", required = false) String userId,
            @RequestHeader(value = "X-User-Role", required = false) String role) {
        exigirLogin(userId, role);
        if (!"operador".equals(role)) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "apenas operador");
        return repo.ultimos(50).stream().map(this::json).toList();
    }

    private static void validarDestino(PedidoServico.Destino d) {
        if (d == null || d.lat() == null || d.lon() == null || Math.abs(d.lat()) > 90 || Math.abs(d.lon()) > 180) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "destino {lat, lon} obrigatório e válido");
        }
    }

    private static void exigirLogin(String userId, String role) {
        if (userId == null || role == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    }

    /** O cliente só vê os próprios pedidos; o entregador, só os da sua entrega. Pedido alheio = 404. */
    private Pedido visivel(long id, String userId, String role, String entregadorId) {
        exigirLogin(userId, role);
        Pedido p = repo.buscar(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        boolean pode =
                switch (role) {
                    case "operador" -> true;
                    case "cliente" -> userId.equals(p.clienteId());
                    case "entregador" -> entregadorId != null && p.entregadorId() != null && entregadorId.equals(String.valueOf(p.entregadorId()));
                    default -> false;
                };
        if (!pode) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return p;
    }

    private Map<String, Object> json(Pedido p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", p.id());
        m.put("status", p.status());
        m.put("motivo", p.motivo());
        m.put("origem", Map.of("nome", regras.origemNome, "lat", p.origemLat(), "lon", p.origemLon()));
        if (p.temDestino()) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("lat", p.destinoLat());
            d.put("lon", p.destinoLon());
            d.put("endereco", p.destinoEndereco());
            m.put("destino", d);
        } else {
            m.put("destino", null);
        }
        m.put("entregadorId", p.entregadorId());
        m.put("criadoEm", p.criadoEm().toString());
        m.put("atualizadoEm", p.atualizadoEm().toString());
        return m;
    }
}
