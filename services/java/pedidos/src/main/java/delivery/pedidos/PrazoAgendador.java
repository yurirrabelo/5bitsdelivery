package delivery.pedidos;

import delivery.commons.Outbox;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
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
            marcarNoTraceDoPedido(id, (String) c[2]);
            outbox.publicar("pedido.cancelado", correlationId.toString(), Map.of("pedidoId", id, "motivo", "PRAZO_EXPIRADO"), (String) c[2]);
            log.info("pedido {} cancelado: prazo de pagamento vencido", id);
        }
        return cancelados.size();
    }

    /** Um span curto dentro do trace do pedido, para o Grafana ver que ele terminou por prazo vencido. */
    private static void marcarNoTraceDoPedido(long pedidoId, String traceparent) {
        Context pai = Context.root();
        try {
            String[] p = traceparent == null ? new String[0] : traceparent.split("-");
            if (p.length >= 4) {
                SpanContext remoto = SpanContext.createFromRemoteParent(p[1], p[2], TraceFlags.fromHex(p[3], 0), TraceState.getDefault());
                if (remoto.isValid()) pai = Context.root().with(Span.wrap(remoto));
            }
        } catch (RuntimeException e) {
            // traceparent ilegível: o span fica num trace novo, o que não atrapalha o cancelamento
        }
        Span span = GlobalOpenTelemetry.getTracer("delivery.pedidos")
                .spanBuilder("pedido.prazo_expirado")
                .setParent(pai)
                .startSpan();
        try {
            span.setAttribute("pedido.id", pedidoId);
            PedidoRepositorio.marcarResultado(span, "CANCELADO", "PRAZO_EXPIRADO");
        } finally {
            span.end();
        }
    }
}
