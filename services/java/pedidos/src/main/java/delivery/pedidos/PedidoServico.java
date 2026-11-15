package delivery.pedidos;

import delivery.commons.Outbox;
import delivery.commons.Trace;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PedidoServico {
    /** Cliente do QR passou do limite de pedidos em andamento (409). */
    public static class LimiteExcedidoException extends RuntimeException {
        public LimiteExcedidoException() {
            super("limite de pedidos em andamento atingido");
        }
    }

    public record Destino(Double lat, Double lon, String endereco) {}

    private final PedidoRepositorio repo;
    private final Outbox outbox;
    private final RegrasPedidos regras;

    public PedidoServico(PedidoRepositorio repo, Outbox outbox, RegrasPedidos regras) {
        this.repo = repo;
        this.outbox = outbox;
        this.regras = regras;
    }

    /**
     * Grava o pedido como RECEBIDO e deixa o comando estoque.reservar na outbox, na mesma transação.
     * O correlationId nasce aqui e acompanha todas as mensagens do pedido.
     */
    @Transactional
    public long criar(String clienteId, boolean aplicarLimite, Destino destino, Integer entregadorPreferidoId) {
        if (aplicarLimite) {
            repo.travarCliente(clienteId);
            if (repo.contarEmAndamento(clienteId) >= regras.limiteClienteEmAndamento) {
                throw new LimiteExcedidoException();
            }
        }
        UUID correlationId = UUID.randomUUID();
        String traceparent = Trace.traceparentAtual(); // o agendador do prazo reaproveita este trace
        long id = repo.inserir(
                clienteId,
                regras.origemLat,
                regras.origemLon,
                destino == null ? null : destino.lat(),
                destino == null ? null : destino.lon(),
                destino == null ? null : destino.endereco(),
                entregadorPreferidoId,
                correlationId,
                traceparent);
        // o clienteId é opcional no contrato: o serviço consultas (CQRS) o usa para o cliente ver só os próprios pedidos
        outbox.publicar("estoque.reservar", correlationId.toString(), Map.of("pedidoId", id, "clienteId", clienteId), traceparent);
        return id;
    }
}
