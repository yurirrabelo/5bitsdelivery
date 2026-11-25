package delivery.estoque;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import delivery.commons.Envelope;
import delivery.commons.Json;
import delivery.commons.ManipuladorMensagem;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/** A reserva é um UPDATE condicional: sob corrida, nenhuma unidade é vendida duas vezes. */
@SpringBootTest(classes = EstoqueApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class EstoqueTest {
    static final int UNIDADES = 10;

    static String env(String nome, String padrao) {
        String v = System.getenv(nome);
        return v == null || v.isBlank() ? padrao : v;
    }

    @DynamicPropertySource
    static void propriedades(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> env("TEST_PG_URL", "jdbc:postgresql://localhost:5432/teste") + "?currentSchema=t_estoque");
        r.add("spring.datasource.username", () -> env("TEST_PG_USER", "teste"));
        r.add("spring.datasource.password", () -> env("TEST_PG_PASSWORD", "teste"));
        r.add("spring.flyway.default-schema", () -> "t_estoque");
        r.add("spring.flyway.create-schemas", () -> "true");
        r.add("spring.rabbitmq.addresses", () -> env("TEST_AMQP_URL", "amqp://teste:teste@localhost:5672"));
        r.add("CONTRACTS_DIR", () -> env("CONTRACTS_DIR", "../../../contracts"));
        r.add("RABBITMQ_EXCHANGE", () -> "ex.teste.estoque");
        r.add("FILA_ESTOQUE", () -> "q.teste.estoque");
        r.add("ITEM_QUANTIDADE", () -> String.valueOf(UNIDADES));
        r.add("delivery.outbox.intervalo-ms", () -> "3600000");
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired List<ManipuladorMensagem> manipuladores;
    @Autowired PlatformTransactionManager transacoes;
    @Value("${local.server.port}") int porta;

    @BeforeEach
    void repor() {
        jdbc.execute("TRUNCATE reservas, outbox, mensagens_processadas");
        jdbc.update("UPDATE estoque SET total = ?, disponivel = ?, reservado = 0, vendido = 0", UNIDADES, UNIDADES);
    }

    private void receber(String tipo, long pedidoId) {
        Envelope e = new Envelope(UUID.randomUUID().toString(), UUID.randomUUID().toString(), tipo, 1, Instant.now().toString(),
                Json.MAPPER.valueToTree(Map.of("pedidoId", pedidoId, "motivo", "PAGAMENTO_RECUSADO")));
        ManipuladorMensagem m = manipuladores.stream().filter(x -> x.tipo().equals(tipo)).findFirst().orElseThrow();
        new TransactionTemplate(transacoes).executeWithoutResult(s -> m.tratar(e));
    }

    private Map<String, Object> estoque() {
        return jdbc.queryForMap("SELECT total, disponivel, reservado, vendido FROM estoque WHERE produto_id = 1");
    }

    private int n(String coluna) {
        return ((Number) estoque().get(coluna)).intValue();
    }

    private int respostas(String tipo) {
        return jdbc.queryForObject("SELECT count(*) FROM outbox WHERE type = ?", Integer.class, tipo);
    }

    /** disponivel + reservado + vendido = total e disponivel >= 0 */
    private void conferirInvariante() {
        assertTrue(n("disponivel") >= 0);
        assertEquals(n("total"), n("disponivel") + n("reservado") + n("vendido"));
    }

    @Test
    void sementeCriaOItemComAQuantidadeConfigurada() {
        assertEquals(UNIDADES, n("total"));
        assertEquals(UNIDADES, n("disponivel"));
    }

    @Test
    void reservaUmaUnidadeERespondeReservado() {
        receber("estoque.reservar", 1);
        assertEquals(UNIDADES - 1, n("disponivel"));
        assertEquals(1, n("reservado"));
        assertEquals(1, respostas("estoque.reservado"));
        conferirInvariante();
    }

    @Test
    void f5_corridaCom40PedidosPara10Unidades_exatamente10ReservamE30Esgotam() throws Exception {
        int pedidos = 40;
        ExecutorService pool = Executors.newFixedThreadPool(pedidos);
        CountDownLatch largada = new CountDownLatch(1);
        CountDownLatch fim = new CountDownLatch(pedidos);
        for (long id = 1; id <= pedidos; id++) {
            long pedidoId = id;
            pool.submit(() -> {
                try {
                    largada.await();
                    receber("estoque.reservar", pedidoId);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    fim.countDown();
                }
            });
        }
        largada.countDown(); // todos de uma vez
        fim.await();
        pool.shutdown();

        assertEquals(UNIDADES, respostas("estoque.reservado"));
        assertEquals(pedidos - UNIDADES, respostas("estoque.esgotado"));
        assertEquals(0, n("disponivel"));
        assertEquals(UNIDADES, n("reservado"));
        assertEquals(UNIDADES, jdbc.queryForObject("SELECT count(*) FROM reservas", Integer.class)); // só as que reservaram
        conferirInvariante();
    }

    @Test
    void comandoRepetidoDoMesmoPedidoNaoConsomeOutraUnidade() {
        receber("estoque.reservar", 7);
        receber("estoque.reservar", 7); // outro messageId, mesmo pedido
        assertEquals(UNIDADES - 1, n("disponivel"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM reservas WHERE pedido_id = 7", Integer.class));
        assertEquals(2, respostas("estoque.reservado")); // repete a resposta, sem nova reserva
        conferirInvariante();
    }

    @Test
    void pedidoConfirmadoTransformaAReservaEmVenda_umaVezSo() {
        receber("estoque.reservar", 1);
        receber("pedido.confirmado", 1);
        receber("pedido.confirmado", 1);
        assertEquals(0, n("reservado"));
        assertEquals(1, n("vendido"));
        assertEquals(UNIDADES - 1, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void pedidoCanceladoDevolveAUnidade_umaVezSo() {
        receber("estoque.reservar", 1);
        receber("pedido.cancelado", 1);
        receber("pedido.cancelado", 1);
        assertEquals(UNIDADES, n("disponivel"));
        assertEquals(0, n("reservado"));
        conferirInvariante();
    }

    @Test
    void pedidoCanceladoNaoMexeNoQueJaFoiVendido() {
        receber("estoque.reservar", 1);
        receber("pedido.confirmado", 1);
        receber("pedido.cancelado", 1); // fora de hora: a reserva já virou venda
        assertEquals(1, n("vendido"));
        assertEquals(UNIDADES - 1, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void unidadeDevolvidaPodeSerReservadaPorOutroPedido() {
        for (long id = 1; id <= UNIDADES; id++) receber("estoque.reservar", id);
        receber("estoque.reservar", 99); // esgotado
        assertEquals(1, respostas("estoque.esgotado"));
        receber("pedido.cancelado", 3);
        receber("estoque.reservar", 100);
        assertEquals(UNIDADES + 1, respostas("estoque.reservado"));
        assertEquals(0, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void getEstoqueMostraOsContadores() throws Exception {
        receber("estoque.reservar", 1);
        HttpResponse<String> r = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + porta + "/api/estoque")).header("X-User-Id", "operador").build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, r.statusCode());
        JsonNode j = Json.MAPPER.readTree(r.body());
        assertEquals(UNIDADES, j.get("total").asInt());
        assertEquals(UNIDADES - 1, j.get("disponivel").asInt());
        assertEquals(1, j.get("reservado").asInt());
        assertEquals(401, HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + porta + "/api/estoque")).build(), HttpResponse.BodyHandlers.ofString()).statusCode());
    }
}
