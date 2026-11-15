package delivery.commons;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

class ContratoValidadorTest {
    private final ContratoValidador validador = new ContratoValidador(Ambiente.dirContratos());
    private final String correlacao = UUID.randomUUID().toString();

    private JsonNode json(String tipo, Object payload) {
        return Json.MAPPER.valueToTree(Envelope.novo(tipo, correlacao, payload));
    }

    @Test
    void aceitaMensagensValidas() {
        assertDoesNotThrow(() -> validador.validar(json("estoque.reservar", Map.of("pedidoId", 1))));
        assertDoesNotThrow(() -> validador.validar(json("pagamento.cobrar", Map.of("pedidoId", 1, "expiraEm", "2026-11-26T19:03:12Z"))));
        assertDoesNotThrow(() -> validador.validar(json("pagamento.recusado", Map.of("pedidoId", 1, "motivo", "GATEWAY_FALHOU"))));
        assertDoesNotThrow(() -> validador.validar(json("entrega.concluida", Map.of("pedidoId", 1, "entregadorId", 2, "modo", "geofence"))));
    }

    @Test
    void aceitaPedidoConfirmadoSemDestino() {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("pedidoId", 7);
        payload.put("origem", Map.of("lat", -26.9, "lon", -49.0));
        payload.put("destino", null);
        payload.put("entregadorPreferidoId", null);
        assertDoesNotThrow(() -> validador.validar(json("pedido.confirmado", payload)));
    }

    @Test
    void toleraCamposAMaisNoPayload() {
        assertDoesNotThrow(() -> validador.validar(json("estoque.reservar", Map.of("pedidoId", 1, "campoNovo", "x"))));
    }

    @Test
    void rejeitaPayloadInvalido() {
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(json("estoque.reservar", Map.of("outro", 1))));
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(json("estoque.reservar", Map.of("pedidoId", "abc"))));
        assertThrows(
                MensagemInvalidaException.class,
                () -> validador.validar(json("entrega.concluida", Map.of("pedidoId", 1, "entregadorId", 1, "modo", "telepatia"))));
    }

    @Test
    void rejeitaEnvelopeInvalido() {
        ObjectNode semId = (ObjectNode) json("estoque.reservar", Map.of("pedidoId", 1));
        semId.put("messageId", "nao-e-uuid");
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(semId));
        semId.remove("messageId");
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(semId));
    }

    @Test
    void rejeitaTipoOuVersaoDesconhecidos() {
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(json("coisa.inventada", Map.of())));
        ObjectNode v9 = (ObjectNode) json("estoque.reservar", Map.of("pedidoId", 1));
        v9.put("version", 9);
        assertThrows(MensagemInvalidaException.class, () -> validador.validar(v9));
    }
}
