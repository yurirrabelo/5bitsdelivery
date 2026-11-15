package delivery.commons;

import com.networknt.schema.Error;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import tools.jackson.databind.JsonNode;

/** Valida o envelope e o payload contra contracts/schemas, na versão informada pela mensagem. */
public class ContratoValidador {
    private static final String ARQUIVO_ENVELOPE = "envelope.schema.json";

    private final Map<String, Schema> schemas = new HashMap<>();

    public ContratoValidador(Path dirSchemas) {
        // formatAssertionsEnabled: "format" (uuid, date-time) vira validação, não só anotação
        SchemaRegistry registro = SchemaRegistry.withDefaultDialect(
                SpecificationVersion.DRAFT_2020_12,
                b -> b.schemaRegistryConfig(
                        SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build()));
        try (Stream<Path> arquivos = Files.list(dirSchemas)) {
            for (Path arquivo : arquivos.filter(p -> p.getFileName().toString().endsWith(".schema.json")).toList()) {
                schemas.put(arquivo.getFileName().toString(), registro.getSchema(Files.readString(arquivo)));
            }
        } catch (IOException e) {
            throw new IllegalStateException("não consegui ler os contratos em " + dirSchemas, e);
        }
        if (!schemas.containsKey(ARQUIVO_ENVELOPE)) {
            throw new IllegalStateException(ARQUIVO_ENVELOPE + " não encontrado em " + dirSchemas);
        }
    }

    /** Valida o JSON recebido e devolve o envelope. Lança MensagemInvalidaException se violar o contrato. */
    public Envelope validar(JsonNode json) {
        List<Error> erros = schemas.get(ARQUIVO_ENVELOPE).validate(json);
        if (!erros.isEmpty()) {
            throw new MensagemInvalidaException("envelope inválido: " + resumir(erros));
        }
        Envelope envelope = Json.MAPPER.treeToValue(json, Envelope.class);
        Schema schema = schemas.get(envelope.type() + ".v" + envelope.version() + ".schema.json");
        if (schema == null) {
            throw new MensagemInvalidaException("contrato desconhecido: " + envelope.type() + " v" + envelope.version());
        }
        List<Error> errosPayload = schema.validate(envelope.payload());
        if (!errosPayload.isEmpty()) {
            throw new MensagemInvalidaException("payload de " + envelope.type() + " inválido: " + resumir(errosPayload));
        }
        return envelope;
    }

    private static String resumir(List<Error> erros) {
        return erros.stream().map(Error::getMessage).collect(Collectors.joining("; "));
    }
}
