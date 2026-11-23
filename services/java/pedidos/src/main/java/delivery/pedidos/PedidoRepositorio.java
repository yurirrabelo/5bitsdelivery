package delivery.pedidos;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class PedidoRepositorio {
    /** Uma linha de histórico, pronta para a API. */
    public record Transicao(String de, String para, String gatilho, String correlationId, String ocorridoEm) {}

    private final JdbcTemplate jdbc;
    private final PedidosMetricas metricas;

    public PedidoRepositorio(JdbcTemplate jdbc, PedidosMetricas metricas) {
        this.jdbc = jdbc;
        this.metricas = metricas;
    }

    private static final RowMapper<Pedido> MAPA = PedidoRepositorio::mapear;

    private static Pedido mapear(ResultSet rs, int i) throws SQLException {
        return new Pedido(
                rs.getLong("id"),
                rs.getString("status"),
                rs.getString("motivo"),
                rs.getString("cliente_id"),
                rs.getDouble("origem_lat"),
                rs.getDouble("origem_lon"),
                rs.getObject("destino_lat", Double.class),
                rs.getObject("destino_lon", Double.class),
                rs.getString("destino_endereco"),
                rs.getObject("entregador_preferido_id", Integer.class),
                rs.getObject("entregador_id", Integer.class),
                rs.getBoolean("promocao"),
                rs.getObject("correlation_id", UUID.class),
                rs.getString("traceparent"),
                instante(rs, "prazo_pagamento"),
                instante(rs, "criado_em"),
                instante(rs, "atualizado_em"));
    }

    private static java.time.Instant instante(ResultSet rs, String coluna) throws SQLException {
        OffsetDateTime t = rs.getObject(coluna, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }

    public long inserir(
            String clienteId,
            double origemLat,
            double origemLon,
            Double destinoLat,
            Double destinoLon,
            String endereco,
            Integer preferido,
            boolean promocao,
            UUID correlationId,
            String traceparent) {
        Long id = jdbc.queryForObject(
                "INSERT INTO pedidos (status, cliente_id, origem_lat, origem_lon, destino_lat, destino_lon, "
                        + "destino_endereco, entregador_preferido_id, promocao, correlation_id, traceparent) "
                        + "VALUES ('RECEBIDO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                Long.class,
                clienteId,
                origemLat,
                origemLon,
                destinoLat,
                destinoLon,
                endereco,
                preferido,
                promocao,
                correlationId,
                traceparent);
        registrarHistorico(id, null, "RECEBIDO", "POST /api/pedidos", correlationId);
        metricas.transicao("RECEBIDO");
        return id;
    }

    public Optional<Pedido> buscar(long id) {
        return jdbc.query("SELECT * FROM pedidos WHERE id = ?", MAPA, id).stream().findFirst();
    }

    public List<Pedido> ultimos(int n) {
        return jdbc.query("SELECT * FROM pedidos ORDER BY id DESC LIMIT ?", MAPA, n);
    }

    public int contarEmAndamento(String clienteId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM pedidos WHERE cliente_id = ? AND status IN ('RECEBIDO', 'AGUARDANDO_PAGAMENTO')",
                Integer.class,
                clienteId);
        return n == null ? 0 : n;
    }

    /** Impede dois pedidos simultâneos do mesmo cliente de passarem juntos pelo limite. Vale até o fim da transação. */
    public void travarCliente(String clienteId) {
        jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtext(?))::text", String.class, clienteId);
    }

    /**
     * Toda mudança de estado é um UPDATE condicional (WHERE id = ? AND status = ?). Se nenhuma linha mudou,
     * a mensagem não se aplica mais (corrida, duplicata, fora de hora) e é ignorada. Quem mudou, grava o histórico.
     */
    public boolean transicionar(long id, String de, String para, String motivo, String gatilho, UUID correlationId) {
        return transicionar(id, de, para, motivo, gatilho, correlationId, null, null);
    }

    /**
     * @param atribuicaoExtra trecho SQL fixo com colunas a atualizar junto (sem dados do usuário), ou null
     * @param condicaoExtra trecho SQL fixo com uma condição a mais no WHERE, ou null
     */
    public boolean transicionar(
            long id,
            String de,
            String para,
            String motivo,
            String gatilho,
            UUID correlationId,
            String atribuicaoExtra,
            String condicaoExtra) {
        int n = jdbc.update(
                "UPDATE pedidos SET status = ?, motivo = COALESCE(?, motivo), atualizado_em = now()"
                        + (atribuicaoExtra == null ? "" : ", " + atribuicaoExtra)
                        + " WHERE id = ? AND status = ?"
                        + (condicaoExtra == null ? "" : " AND " + condicaoExtra),
                para,
                motivo,
                id,
                de);
        if (n == 0) return false;
        registrarHistorico(id, de, para, gatilho, correlationId);
        metricas.transicao(para);
        marcarResultado(Span.current(), para, motivo);
        return true;
    }

    /**
     * Grava no span como o pedido terminou, para o Grafana listar o resultado de cada pedido. Quando não deu certo,
     * o span também vira erro: é o que pinta de vermelho o ponto da falha no Grafana.
     */
    static void marcarResultado(Span span, String para, String motivo) {
        String resultado = switch (para) {
            case "CONFIRMADO" -> "sucesso";
            case "ESGOTADO" -> "esgotado";
            case "ESTORNADO" -> "estornado";
            case "CANCELADO" -> "PRAZO_EXPIRADO".equals(motivo) ? "prazo_expirado" : "recusado";
            default -> null;
        };
        if (resultado == null) return;
        span.setAttribute("pedido.resultado", resultado);
        String falha = switch (resultado) {
            case "esgotado" -> "estoque esgotado";
            case "estornado" -> "pagamento estornado";
            case "prazo_expirado" -> "pagamento demorou demais";
            case "recusado" -> "pagamento recusado";
            default -> null;
        };
        if (falha != null) span.setStatus(StatusCode.ERROR, falha);
    }

    /** Pedidos com prazo vencido viram CANCELADO numa instrução só. Devolve (id, correlationId, traceparent). */
    public List<Object[]> cancelarVencidos() {
        List<Object[]> cancelados = jdbc.query(
                "UPDATE pedidos SET status = 'CANCELADO', motivo = 'PRAZO_EXPIRADO', atualizado_em = now() "
                        + "WHERE status = 'AGUARDANDO_PAGAMENTO' AND prazo_pagamento <= now() "
                        + "RETURNING id, correlation_id, traceparent",
                (rs, i) -> new Object[] {rs.getLong("id"), rs.getObject("correlation_id", UUID.class), rs.getString("traceparent")});
        for (Object[] c : cancelados) {
            registrarHistorico((Long) c[0], "AGUARDANDO_PAGAMENTO", "CANCELADO", "prazo de pagamento vencido", (UUID) c[1]);
            metricas.transicao("CANCELADO");
        }
        return cancelados;
    }

    public List<Transicao> historico(long pedidoId) {
        return jdbc.query(
                "SELECT de_status, para_status, gatilho, correlation_id, ocorrido_em FROM historico WHERE pedido_id = ? ORDER BY id",
                (rs, i) -> new Transicao(
                        rs.getString("de_status"),
                        rs.getString("para_status"),
                        rs.getString("gatilho"),
                        rs.getString("correlation_id"),
                        rs.getObject("ocorrido_em", OffsetDateTime.class).toInstant().toString()),
                pedidoId);
    }

    private void registrarHistorico(long pedidoId, String de, String para, String gatilho, UUID correlationId) {
        jdbc.update(
                "INSERT INTO historico (pedido_id, de_status, para_status, gatilho, correlation_id) VALUES (?, ?, ?, ?, ?)",
                pedidoId,
                de,
                para,
                gatilho,
                correlationId);
    }
}
