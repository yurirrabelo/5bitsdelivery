package delivery.commons;

import java.time.Instant;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Envelope igual para toda mensagem (contracts/schemas/envelope.schema.json). */
public record Envelope(
        String messageId, String correlationId, String type, int version, String occurredAt, JsonNode payload) {

    public static Envelope novo(String type, String correlationId, Object payload) {
        return novo(type, correlationId, payload, 1);
    }

    public static Envelope novo(String type, String correlationId, Object payload, int version) {
        return new Envelope(
                UUID.randomUUID().toString(),
                correlationId,
                type,
                version,
                Instant.now().toString(),
                payload instanceof JsonNode no ? no : Json.MAPPER.valueToTree(payload));
    }

    /** Campo numérico do payload (ex.: pedidoId), ou null se não existir. */
    public Long payloadLong(String campo) {
        JsonNode no = payload == null ? null : payload.get(campo);
        return no != null && no.isNumber() ? no.asLong() : null;
    }
}
