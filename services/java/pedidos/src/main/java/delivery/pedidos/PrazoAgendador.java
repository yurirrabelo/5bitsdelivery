package delivery.pedidos;

import delivery.commons.Outbox;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * A cada segundo cancela, com UPDATE condicional, os pedidos AGUARDANDO_PAGAMENTO com prazo vencido e deixa
 * pedido.cancelado na outbox na mesma transação. Se o serviço ficou fora do ar, ao voltar cancela tudo que venceu.
 */
@Component
public class PrazoAgendador {
    private static final Logger log = LoggerFactory.getLogger(PrazoAgendador.class);

    private final PedidoRepositorio repo;
    private final Outbox outbox;

    public PrazoAgendador(PedidoRepositorio repo, Outbox outbox) {
        this.repo = repo;
        this.outbox = outbox;
    }

    @Scheduled(fixedDelayString = "${delivery.prazo.intervalo-ms:1000}")
    public void executar() {
        try {
            cancelarVencidos();
        } catch (Exception e) {
            log.warn("agendador do prazo: banco indisponível, tento no próximo ciclo ({})", e.toString());
        }
    }

    @Transactional
    public int cancelarVencidos() {
        var cancelados = repo.cancelarVencidos();
        for (Object[] c : cancelados) {
            long id = (Long) c[0];
            UUID correlationId = (UUID) c[1];
            // sem trace ativo no agendador: usa o traceparent guardado no pedido
            outbox.publicar("pedido.cancelado", correlationId.toString(), Map.of("pedidoId", id, "motivo", "PRAZO_EXPIRADO"), (String) c[2]);
            log.info("pedido {} cancelado: prazo de pagamento vencido", id);
        }
        return cancelados.size();
    }
}
