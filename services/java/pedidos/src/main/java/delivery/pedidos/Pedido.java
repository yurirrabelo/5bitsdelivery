package delivery.pedidos;

import java.time.Instant;
import java.util.UUID;

/** Linha da tabela pedidos. */
public record Pedido(
        long id,
        String status,
        String motivo,
        String clienteId,
        double origemLat,
        double origemLon,
        Double destinoLat,
        Double destinoLon,
        String destinoEndereco,
        Integer entregadorPreferidoId,
        Integer entregadorId,
        boolean promocao,
        UUID correlationId,
        String traceparent,
        Instant prazoPagamento,
        Instant criadoEm,
        Instant atualizadoEm) {

    public boolean temDestino() {
        return destinoLat != null && destinoLon != null;
    }
}
