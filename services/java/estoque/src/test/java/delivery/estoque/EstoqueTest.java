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

/**
 * São 30 itens: 10 com cupom (produto 2) e 20 normais (produto 1). A reserva é um UPDATE condicional: sob corrida,
 * nenhuma unidade é vendida duas vezes, e cada grupo esgota sozinho.
 */
@SpringBootTest(classes = EstoqueApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class EstoqueTest {
    static final int COM_CUPOM = 10;
    static final int NORMAIS = 20;
    static final int TOTAL = COM_CUPOM + NORMAIS;

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
        r.add("ITEM_QUANTIDADE", () -> String.valueOf(TOTAL));
        r.add("PROMOCAO_QUANTIDADE", () -> String.valueOf(COM_CUPOM));
        r.add("delivery.outbox.intervalo-ms", () -> "3600000");
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired List<ManipuladorMensagem> manipuladores;
    @Autowired PlatformTransactionManager transacoes;
    @Value("${local.server.port}") int porta;

    @BeforeEach
    void repor() {
        jdbc.execute("TRUNCATE reservas, outbox, mensagens_processadas");
        jdbc.update("UPDATE estoque SET total = ?, disponivel = ?, reservado = 0, vendido = 0 WHERE produto_id = ?", NORMAIS, NORMAIS, SementeEstoque.PRODUTO);
        jdbc.update("UPDATE estoque SET total = ?, disponivel = ?, reservado = 0, vendido = 0 WHERE produto_id = ?", COM_CUPOM, COM_CUPOM, SementeEstoque.PRODUTO_CUPOM);
    }

    private void tratar(String tipo, Map<String, Object> payload) {
        Envelope e = new Envelope(UUID.randomUUID().toString(), UUID.randomUUID().toString(), tipo, 1, Instant.now().toString(),
                Json.MAPPER.valueToTree(payload));
        ManipuladorMensagem m = manipuladores.stream().filter(x -> x.tipo().equals(tipo)).findFirst().orElseThrow();
        new TransactionTemplate(transacoes).executeWithoutResult(s -> m.tratar(e));
    }

    /** Mensagem do pedido sem cupom (item normal) ou, nos pedidos.confirmado/cancelado, a que o pedido manda ao fim. */
    private void receber(String tipo, long pedidoId) {
        tratar(tipo, Map.of("pedidoId", pedidoId, "motivo", "PAGAMENTO_RECUSADO"));
    }

    /** estoque.reservar de um pedido que usou o cupom: sai um dos itens com cupom. */
    private void reservarComCupom(long pedidoId) {
        tratar("estoque.reservar", Map.of("pedidoId", pedidoId, "cupom", true));
    }

    private int n(int produto, String coluna) {
        return ((Number) jdbc.queryForMap("SELECT total, disponivel, reservado, vendido FROM estoque WHERE produto_id = ?", produto).get(coluna)).intValue();
    }

    /** itens normais */
    private int n(String coluna) {
        return n(SementeEstoque.PRODUTO, coluna);
    }

    /** itens com cupom */
    private int c(String coluna) {
        return n(SementeEstoque.PRODUTO_CUPOM, coluna);
    }

    private int respostas(String tipo) {
        return jdbc.queryForObject("SELECT count(*) FROM outbox WHERE type = ?", Integer.class, tipo);
    }

    /** disponivel + reservado + vendido = total e disponivel >= 0, nos dois grupos */
    private void conferirInvariante() {
        for (int produto : new int[] {SementeEstoque.PRODUTO, SementeEstoque.PRODUTO_CUPOM}) {
            assertTrue(n(produto, "disponivel") >= 0);
            assertEquals(n(produto, "total"), n(produto, "disponivel") + n(produto, "reservado") + n(produto, "vendido"));
        }
    }

    @Test
    void sementeCriaOsDoisGruposComAsQuantidadesConfiguradas() {
        // 30 itens no total: 10 com cupom e 20 normais
        assertEquals(NORMAIS, n("total"));
        assertEquals(NORMAIS, n("disponivel"));
        assertEquals(COM_CUPOM, c("total"));
        assertEquals(COM_CUPOM, c("disponivel"));
    }

    @Test
    void reservaUmaUnidadeERespondeReservado() {
        receber("estoque.reservar", 1);
        assertEquals(NORMAIS - 1, n("disponivel"));
        assertEquals(1, n("reservado"));
        assertEquals(COM_CUPOM, c("disponivel")); // o pedido sem cupom não mexe nos itens com cupom
        assertEquals(1, respostas("estoque.reservado"));
        conferirInvariante();
    }

    @Test
    void pedidoComCupomUsaUmItemComCupom_eNaoMexeNosNormais() {
        reservarComCupom(1);
        assertEquals(COM_CUPOM - 1, c("disponivel"));
        assertEquals(1, c("reservado"));
        assertEquals(NORMAIS, n("disponivel"));
        assertEquals(1, respostas("estoque.reservado"));
        conferirInvariante();
    }

    @Test
    void f5_corridaCom40PedidosComCupomPara10Itens_exatamente10ReservamE30Esgotam() throws Exception {
        int pedidos = 40;
        ExecutorService pool = Executors.newFixedThreadPool(pedidos);
        CountDownLatch largada = new CountDownLatch(1);
        CountDownLatch fim = new CountDownLatch(pedidos);
        for (long id = 1; id <= pedidos; id++) {
            long pedidoId = id;
            pool.submit(() -> {
                try {
                    largada.await();
                    reservarComCupom(pedidoId);
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

        assertEquals(COM_CUPOM, respostas("estoque.reservado"));
        assertEquals(pedidos - COM_CUPOM, respostas("estoque.esgotado"));
        assertEquals(0, c("disponivel"));
        assertEquals(COM_CUPOM, c("reservado"));
        assertEquals(COM_CUPOM, jdbc.queryForObject("SELECT count(*) FROM reservas", Integer.class)); // só as que reservaram
        assertEquals(NORMAIS, n("disponivel")); // os itens normais seguem intactos
        conferirInvariante();
    }

    @Test
    void cadaGrupoEsgotaSozinho() {
        for (long id = 1; id <= COM_CUPOM; id++) reservarComCupom(id);
        reservarComCupom(99); // os 10 itens com cupom acabaram
        assertEquals(1, respostas("estoque.esgotado"));
        receber("estoque.reservar", 100); // o item normal continua disponível
        assertEquals(COM_CUPOM + 1, respostas("estoque.reservado"));
        assertEquals(NORMAIS - 1, n("disponivel"));

        for (long id = 101; id < 101 + NORMAIS - 1; id++) receber("estoque.reservar", id);
        receber("estoque.reservar", 999); // agora os normais também acabaram
        assertEquals(2, respostas("estoque.esgotado"));
        assertEquals(0, n("disponivel"));
        assertEquals(0, c("disponivel"));
        conferirInvariante();
    }

    @Test
    void comandoRepetidoDoMesmoPedidoNaoConsomeOutraUnidade() {
        receber("estoque.reservar", 7);
        receber("estoque.reservar", 7); // outro messageId, mesmo pedido
        assertEquals(NORMAIS - 1, n("disponivel"));
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
        assertEquals(NORMAIS - 1, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void pedidoConfirmadoComCupomVendeUmItemComCupom() {
        reservarComCupom(1);
        receber("pedido.confirmado", 1);
        assertEquals(0, c("reservado"));
        assertEquals(1, c("vendido"));
        assertEquals(0, n("vendido")); // a venda fica no grupo de onde a unidade saiu
        conferirInvariante();
    }

    @Test
    void pedidoCanceladoDevolveAUnidade_umaVezSo() {
        receber("estoque.reservar", 1);
        receber("pedido.cancelado", 1);
        receber("pedido.cancelado", 1);
        assertEquals(NORMAIS, n("disponivel"));
        assertEquals(0, n("reservado"));
        conferirInvariante();
    }

    @Test
    void pedidoCanceladoComCupomDevolveOItemAosItensComCupom() {
        reservarComCupom(1);
        receber("pedido.cancelado", 1);
        receber("pedido.cancelado", 1);
        assertEquals(COM_CUPOM, c("disponivel"));
        assertEquals(0, c("reservado"));
        assertEquals(NORMAIS, n("disponivel")); // não vai parar nos itens normais
        conferirInvariante();
    }

    @Test
    void pedidoCanceladoNaoMexeNoQueJaFoiVendido() {
        receber("estoque.reservar", 1);
        receber("pedido.confirmado", 1);
        receber("pedido.cancelado", 1); // fora de hora: a reserva já virou venda
        assertEquals(1, n("vendido"));
        assertEquals(NORMAIS - 1, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void unidadeDevolvidaPodeSerReservadaPorOutroPedido() {
        for (long id = 1; id <= NORMAIS; id++) receber("estoque.reservar", id);
        receber("estoque.reservar", 99); // esgotado
        assertEquals(1, respostas("estoque.esgotado"));
        receber("pedido.cancelado", 3);
        receber("estoque.reservar", 100);
        assertEquals(NORMAIS + 1, respostas("estoque.reservado"));
        assertEquals(0, n("disponivel"));
        conferirInvariante();
    }

    @Test
    void getEstoqueMostraOsContadoresDoItemTodoEDeCadaGrupo() throws Exception {
        receber("estoque.reservar", 1);
        reservarComCupom(2);
        HttpResponse<String> r = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + porta + "/api/estoque")).header("X-User-Id", "operador").build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, r.statusCode());
        JsonNode j = Json.MAPPER.readTree(r.body());
        // o item todo: os dois grupos somados
        assertEquals(TOTAL, j.get("total").asInt());
        assertEquals(TOTAL - 2, j.get("disponivel").asInt());
        assertEquals(2, j.get("reservado").asInt());
        // cada grupo
        assertEquals(NORMAIS - 1, j.get("normal").get("disponivel").asInt());
        assertEquals(COM_CUPOM, j.get("cupom").get("total").asInt());
        assertEquals(COM_CUPOM - 1, j.get("cupom").get("disponivel").asInt());
        assertEquals(401, HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + porta + "/api/estoque")).build(), HttpResponse.BodyHandlers.ofString()).statusCode());
    }
}
