package delivery.commons;

import com.rabbitmq.client.Channel;
import io.opentelemetry.api.trace.Span;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.amqp.core.AcknowledgeMode;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener;
import org.springframework.context.SmartLifecycle;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

/**
 * Consumo com ack manual e prefetch 1.
 * <ul>
 *   <li>Erro da mensagem (JSON/contrato inválido, erro do manipulador): reject com requeue. A fila quorum conta
 *       as entregas e, ao passar de x-delivery-limit, manda para a DLQ. As outras mensagens seguem. No RabbitMQ 4
 *       o nack com requeue não incrementa a contagem; o reject com requeue incrementa.</li>
 *   <li>Erro de infraestrutura (banco fora): segura a mensagem sem ack e tenta de novo com backoff. Assim uma
 *       queda de banco não manda mensagem boa para a DLQ.</li>
 *   <li>Duplicada (messageId já na inbox): confirma sem efeito.</li>
 * </ul>
 */
public class ConsumidorMensagens implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ConsumidorMensagens.class);

    private enum Resultado {
        PROCESSADA("processada"),
        DUPLICADA("duplicada");

        final String rotulo;

        Resultado(String rotulo) {
            this.rotulo = rotulo;
        }
    }

    private final SimpleMessageListenerContainer container;
    private final Map<String, ManipuladorMensagem> manipuladores = new HashMap<>();
    private final ContratoValidador validador;
    private final Inbox inbox;
    private final TransactionTemplate tx;
    private final EstadoSaude estado;
    private final Metricas metricas;
    private final long backoffInicialMs;
    private final long backoffMaxMs;

    public ConsumidorMensagens(
            ConnectionFactory conexoes,
            String fila,
            List<ManipuladorMensagem> manipuladores,
            ContratoValidador validador,
            Inbox inbox,
            PlatformTransactionManager transacoes,
            EstadoSaude estado,
            Metricas metricas,
            long backoffInicialMs,
            long backoffMaxMs) {
        manipuladores.forEach(m -> this.manipuladores.put(m.tipo(), m));
        this.validador = validador;
        this.inbox = inbox;
        this.tx = new TransactionTemplate(transacoes);
        this.estado = estado;
        this.metricas = metricas;
        this.backoffInicialMs = backoffInicialMs;
        this.backoffMaxMs = backoffMaxMs;

        container = new SimpleMessageListenerContainer(conexoes);
        container.setQueueNames(fila);
        container.setAcknowledgeMode(AcknowledgeMode.MANUAL);
        container.setPrefetchCount(1);
        container.setConcurrentConsumers(1);
        container.setDefaultRequeueRejected(true);
        // se a fila ainda não existe (Terraform terminando), o consumidor espera em vez de falhar
        container.setMissingQueuesFatal(false);
        container.setRecoveryInterval(2000);
        container.setMessageListener((ChannelAwareMessageListener) this::aoReceber);
    }

    @Override
    public void start() {
        container.start();
    }

    @Override
    public void stop() {
        container.stop();
    }

    @Override
    public boolean isRunning() {
        return container.isRunning();
    }

    private void aoReceber(Message mensagem, Channel canal) {
        String tipo = mensagem.getMessageProperties().getReceivedRoutingKey();
        long tag = mensagem.getMessageProperties().getDeliveryTag();
        long espera = backoffInicialMs;
        for (; ; ) {
            try {
                Resultado r = processar(mensagem);
                estado.segurando(false);
                metricas.mensagem(tipo, r.rotulo);
                responder(() -> canal.basicAck(tag, false));
                return;
            } catch (Exception e) {
                if (ErrosInfra.ehInfra(e)) {
                    estado.segurando(true);
                    log.warn("infraestrutura indisponível; segurando a mensagem {} (espera {} ms): {}", tipo, espera, e.toString());
                    try {
                        Thread.sleep(espera);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return; // desligando: sem ack, a mensagem volta para a fila
                    }
                    espera = Math.min(espera * 2, backoffMaxMs);
                    continue;
                }
                estado.segurando(false);
                metricas.mensagem(tipo, "erro");
                log.error("erro na mensagem {}; devolvendo para a fila: {}", tipo, e.toString());
                responder(() -> canal.basicReject(tag, true));
                return;
            }
        }
    }

    private Resultado processar(Message mensagem) {
        Envelope envelope;
        try {
            JsonNode json = Json.MAPPER.readTree(new String(mensagem.getBody(), StandardCharsets.UTF_8));
            envelope = validador.validar(json);
        } catch (JacksonException e) {
            throw new MensagemInvalidaException("JSON inválido: " + e.getOriginalMessage());
        }
        ManipuladorMensagem manipulador = manipuladores.get(envelope.type());
        if (manipulador == null) {
            throw new MensagemInvalidaException("sem manipulador para " + envelope.type());
        }

        MDC.put("correlationId", envelope.correlationId());
        MDC.put("messageId", envelope.messageId());
        MDC.put("type", envelope.type());
        Long pedidoId = envelope.payloadLong("pedidoId");
        if (pedidoId != null) {
            MDC.put("pedidoId", String.valueOf(pedidoId));
            // o número do pedido no span: o Grafana acha o trace de um pedido por "pedido.id"
            Span.current().setAttribute("pedido.id", pedidoId);
        }
        try {
            return tx.execute(status -> {
                if (!inbox.registrar(envelope)) {
                    log.info("mensagem duplicada descartada");
                    return Resultado.DUPLICADA;
                }
                manipulador.tratar(envelope);
                return Resultado.PROCESSADA;
            });
        } finally {
            MDC.clear();
        }
    }

    private interface Acao {
        void executar() throws IOException;
    }

    // ack/reject falham se o canal caiu no meio; o broker devolve a mensagem e a inbox descarta a repetição
    private void responder(Acao acao) {
        try {
            acao.executar();
        } catch (Exception e) {
            log.warn("não consegui confirmar a mensagem (canal caiu); ela volta para a fila: {}", e.toString());
        }
    }
}
