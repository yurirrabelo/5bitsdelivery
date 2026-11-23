package delivery.pedidos;

import delivery.commons.Envelope;
import delivery.commons.ManipuladorMensagem;
import delivery.commons.Outbox;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * A saga orquestrada: reage a cada resposta (estoque, pagamento, entregas) com uma transição condicional
 * e deixa o próximo comando na outbox. Cada método roda na transação da inbox (ver ConsumidorMensagens).
 * Se a transição não muda nenhuma linha, a mensagem não se aplica mais e é confirmada sem efeito.
 */
@Configuration
public class FluxoPedidos {
    private static final Logger log = LoggerFactory.getLogger(FluxoPedidos.class);

    private final PedidoRepositorio repo;
    private final PedidoServico servico;
    private final Outbox outbox;
    private final RegrasPedidos regras;

    public FluxoPedidos(PedidoRepositorio repo, PedidoServico servico, Outbox outbox, RegrasPedidos regras) {
        this.repo = repo;
        this.servico = servico;
        this.outbox = outbox;
        this.regras = regras;
    }

    @Bean
    ManipuladorMensagem estoqueReservado() {
        return ManipuladorMensagem.de("estoque.reservado", this::aoReservar);
    }

    @Bean
    ManipuladorMensagem estoqueEsgotado() {
        return ManipuladorMensagem.de("estoque.esgotado", this::aoEsgotar);
    }

    @Bean
    ManipuladorMensagem pagamentoAprovado() {
        return ManipuladorMensagem.de("pagamento.aprovado", this::aoAprovar);
    }

    @Bean
    ManipuladorMensagem pagamentoRecusado() {
        return ManipuladorMensagem.de("pagamento.recusado", this::aoRecusar);
    }

    @Bean
    ManipuladorMensagem pagamentoEstornado() {
        return ManipuladorMensagem.de("pagamento.estornado", this::aoEstornar);
    }

    @Bean
    ManipuladorMensagem entregaAtribuida() {
        return ManipuladorMensagem.de("entrega.atribuida", this::aoAtribuir);
    }

    @Bean
    ManipuladorMensagem entregaConcluida() {
        return ManipuladorMensagem.de("entrega.concluida", this::aoConcluir);
    }

    // RECEBIDO -> AGUARDANDO_PAGAMENTO: o estoque reservou a unidade (pedido com cupom); o pedidos manda cobrar
    void aoReservar(Envelope e) {
        long id = e.payloadLong("pedidoId");
        String traceparent = repo.buscar(id).map(Pedido::traceparent).orElse(null);
        servico.aguardarPagamento(id, UUID.fromString(e.correlationId()), "estoque.reservado", traceparent);
    }

    // RECEBIDO -> ESGOTADO (fim)
    void aoEsgotar(Envelope e) {
        repo.transicionar(e.payloadLong("pedidoId"), "RECEBIDO", "ESGOTADO", null, "estoque.esgotado", UUID.fromString(e.correlationId()));
    }

    // AGUARDANDO_PAGAMENTO -> CONFIRMADO, só se ainda estiver no prazo. Depois do cancelamento, estorna.
    void aoAprovar(Envelope e) {
        long id = e.payloadLong("pedidoId");
        UUID corr = UUID.fromString(e.correlationId());
        if (repo.transicionar(id, "AGUARDANDO_PAGAMENTO", "CONFIRMADO", null, "pagamento.aprovado", corr, null, "prazo_pagamento > now()")) {
            Pedido p = repo.buscar(id).orElseThrow();
            outbox.publicar("pedido.confirmado", e.correlationId(), 2, payloadConfirmado(p), p.traceparent());
            return;
        }
        Pedido p = repo.buscar(id).orElse(null);
        if (p == null) return;
        switch (p.status()) {
            // o prazo venceu mas o agendador ainda não cancelou: cancela aqui e estorna a cobrança
            case "AGUARDANDO_PAGAMENTO" -> {
                if (repo.transicionar(id, "AGUARDANDO_PAGAMENTO", "CANCELADO", "PRAZO_EXPIRADO", "pagamento.aprovado depois do prazo", corr)) {
                    outbox.publicar("pedido.cancelado", e.correlationId(), Map.of("pedidoId", id, "motivo", "PRAZO_EXPIRADO"), p.traceparent());
                    outbox.publicar("pagamento.estornar", e.correlationId(), Map.of("pedidoId", id), p.traceparent());
                }
            }
            // aprovação atrasada: o pedido já foi cancelado, então a cobrança precisa ser estornada
            case "CANCELADO" -> outbox.publicar("pagamento.estornar", e.correlationId(), Map.of("pedidoId", id), p.traceparent());
            default -> log.info("aprovação ignorada: pedido {} está {}", id, p.status());
        }
    }

    // AGUARDANDO_PAGAMENTO -> CANCELADO; o estoque devolve a unidade ao receber pedido.cancelado
    void aoRecusar(Envelope e) {
        long id = e.payloadLong("pedidoId");
        String motivoMensagem = e.payload().path("motivo").asString("");
        String motivo = motivoMensagem.equals("PRAZO_EXPIRADO") ? "PRAZO_EXPIRADO" : "PAGAMENTO_RECUSADO";
        if (repo.transicionar(id, "AGUARDANDO_PAGAMENTO", "CANCELADO", motivo, "pagamento.recusado (" + motivoMensagem + ")", UUID.fromString(e.correlationId()))) {
            Pedido p = repo.buscar(id).orElseThrow();
            outbox.publicar("pedido.cancelado", e.correlationId(), Map.of("pedidoId", id, "motivo", motivo), p.traceparent());
        }
    }

    // CANCELADO -> ESTORNADO (fim)
    void aoEstornar(Envelope e) {
        repo.transicionar(e.payloadLong("pedidoId"), "CANCELADO", "ESTORNADO", null, "pagamento.estornado", UUID.fromString(e.correlationId()));
    }

    // CONFIRMADO -> EM_ENTREGA
    void aoAtribuir(Envelope e) {
        long entregadorId = e.payloadLong("entregadorId");
        repo.transicionar(
                e.payloadLong("pedidoId"), "CONFIRMADO", "EM_ENTREGA", null, "entrega.atribuida", UUID.fromString(e.correlationId()),
                "entregador_id = " + entregadorId, null);
    }

    // EM_ENTREGA -> ENTREGUE (fim)
    void aoConcluir(Envelope e) {
        repo.transicionar(e.payloadLong("pedidoId"), "EM_ENTREGA", "ENTREGUE", null, "entrega.concluida", UUID.fromString(e.correlationId()));
    }

    // pedido.confirmado v2: os dados de entrega ficam em "entrega". Destino e entregadorPreferidoId são null
    // nos pedidos do QR (ficam em CONFIRMADO, sem entrega). Quem só conhece a v1 continua funcionando.
    private Map<String, Object> payloadConfirmado(Pedido p) {
        Map<String, Object> origem = new LinkedHashMap<>();
        origem.put("nome", regras.origemNome);
        origem.put("lat", p.origemLat());
        origem.put("lon", p.origemLon());
        Map<String, Object> destino = null;
        if (p.temDestino()) {
            destino = new LinkedHashMap<>();
            destino.put("lat", p.destinoLat());
            destino.put("lon", p.destinoLon());
            destino.put("endereco", p.destinoEndereco());
        }
        Map<String, Object> entrega = new LinkedHashMap<>();
        entrega.put("destino", destino);
        entrega.put("entregadorPreferidoId", p.entregadorPreferidoId());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("pedidoId", p.id());
        payload.put("origem", origem);
        payload.put("entrega", entrega);
        return payload;
    }
}
