package delivery.commons;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import tools.jackson.databind.JsonNode;

/**
 * Na subida, lê as credenciais do Secrets Manager (MiniStack) e as entrega ao Spring como propriedades:
 * SEGREDO_DB (host, port, dbname, username, password) e SEGREDO_RABBITMQ (url). Nada de credencial no código.
 * Também define os padrões da commons (confirm de publicação, locais do Flyway, log em JSON), que o serviço
 * pode sobrescrever no application.yml.
 */
public class SegredosEnvironmentPostProcessor implements EnvironmentPostProcessor {
    private static final int TENTATIVAS = 150; // cerca de 5 minutos esperando o MiniStack

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
        Map<String, Object> padroes = new LinkedHashMap<>();
        padroes.put("spring.rabbitmq.connection-timeout", "3s");
        padroes.put("spring.rabbitmq.publisher-confirm-type", "correlated");
        padroes.put("spring.flyway.locations", "classpath:db/commons,classpath:db/migration");
        padroes.put("logging.structured.format.console", "logstash");
        padroes.put("logging.structured.json.rename.[@timestamp]", "timestamp");
        padroes.put("logging.structured.json.exclude", "@version,level_value,thread_name");
        padroes.put("logging.structured.json.add.service", env.getProperty("OTEL_SERVICE_NAME", "servico"));
        env.getPropertySources().addLast(new MapPropertySource("delivery-padroes", padroes));

        String segredoDb = env.getProperty("SEGREDO_DB");
        String segredoRabbit = env.getProperty("SEGREDO_RABBITMQ");
        if (segredoDb == null && segredoRabbit == null) return;

        Map<String, Object> segredos = new LinkedHashMap<>();
        try (SecretsManagerClient cliente = SecretsManagerClient.builder()
                .endpointOverride(URI.create(env.getRequiredProperty("AWS_ENDPOINT_URL")))
                .region(Region.of(env.getRequiredProperty("AWS_REGION")))
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .build()) {
            if (segredoDb != null) {
                JsonNode db = ler(cliente, segredoDb);
                segredos.put(
                        "spring.datasource.url",
                        "jdbc:postgresql://" + db.get("host").asString() + ":" + db.get("port").asInt() + "/"
                                + db.get("dbname").asString());
                segredos.put("spring.datasource.username", db.get("username").asString());
                segredos.put("spring.datasource.password", db.get("password").asString());
            }
            if (segredoRabbit != null) {
                segredos.put("spring.rabbitmq.addresses", ler(cliente, segredoRabbit).get("url").asString());
            }
        }
        env.getPropertySources().addFirst(new MapPropertySource("delivery-segredos", segredos));
    }

    private static JsonNode ler(SecretsManagerClient cliente, String nome) {
        RuntimeException ultimo = null;
        for (int i = 0; i < TENTATIVAS; i++) {
            try {
                String json = cliente.getSecretValue(r -> r.secretId(nome)).secretString();
                return Json.MAPPER.readTree(json);
            } catch (RuntimeException e) {
                ultimo = e;
                System.err.println("segredo " + nome + " indisponível; tentando de novo: " + e.getMessage());
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(ie);
                }
            }
        }
        throw new IllegalStateException("não consegui ler o segredo " + nome, ultimo);
    }
}
