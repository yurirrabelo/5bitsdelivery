package delivery.pedidos;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
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

/** A máquina de estados do pedido: cada transição é condicional, mensagem fora de hora não muda nada. */
@SpringBootTest(classes = PedidosApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class PedidosTest {
    static String env(String nome, String padrao) {
        String v = System.getenv(nome);
        return v == null || v.isBlank() ? padrao : v;
    }

    @DynamicPropertySource
    static void propriedades(DynamicPropertyRegistry r) {
        String amqp = env("TEST_AMQP_URL", "amqp://teste:teste@localhost:5672");
        // schema próprio: os testes de cada serviço não pisam nas tabelas um do outro
        r.add("spring.datasource.url", () -> env("TEST_PG_URL", "jdbc:postgresql://localhost:5432/teste") + "?currentSchema=t_pedidos");
        r.add("spring.datasource.username", () -> env("TEST_PG_USER", "teste"));
        r.add("spring.datasource.password", () -> env("TEST_PG_PASSWORD", "teste"));
        r.add("spring.flyway.default-schema", () -> "t_pedidos");
        r.add("spring.flyway.create-schemas", () -> "true");
        r.add("spring.rabbitmq.addresses", () -> amqp);
        r.add("CONTRACTS_DIR", () -> env("CONTRACTS_DIR", "../../../contracts"));
        r.add("RABBITMQ_EXCHANGE", () -> "ex.teste.pedidos");
        r.add("FILA_PEDIDOS", () -> "q.teste.pedidos");
        r.add("ORIGEM_LAT", () -> "-26.9194");
        r.add("ORIGEM_LON", () -> "-49.0661");
        // o publicador e o agendador rodam só quando o teste chama (ciclo manual)
        r.add("delivery.outbox.intervalo-ms", () -> "3600000");
        r.add("delivery.prazo.intervalo-ms", () -> "3600000");
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired PedidoServico servico;
    @Autowired PedidoRepositorio repo;
    @Autowired PrazoAgendador agendador;
    @Autowired List<ManipuladorMensagem> manipuladores;
    @Autowired PlatformTransactionManager transacoes;
    @Autowired RabbitTemplate rabbit;
    @Value("${local.server.port}") int porta;

    @BeforeEach
    void limpar() {
        jdbc.execute("TRUNCATE historico, pedidos, outbox, mensagens_processadas RESTART IDENTITY CASCADE");
    }

    // ---------------------------------------------------------------- utilidades

    private long novoPedido(String cliente, boolean limitar, boolean comDestino) {
        return new TransactionTemplate(transacoes).execute(s -> servico.criar(
                cliente, limitar, comDestino ? new PedidoServico.Destino(-26.91, -49.07, "Rua A") : null, comDestino ? 2 : null));
    }

    /** Entrega uma mensagem ao manipulador do tipo, como o consumidor faria (dentro de uma transação). */
    private void receber(String tipo, long pedidoId, Map<String, Object> extra) {
        Pedido p = repo.buscar(pedidoId).orElseThrow();
        Map<String, Object> payload = new java.util.LinkedHashMap<>(extra);
        payload.put("pedidoId", pedidoId);
        Envelope e = new Envelope(UUID.randomUUID().toString(), p.correlationId().toString(), tipo, 1, Instant.now().toString(), Json.MAPPER.valueToTree(payload));
        ManipuladorMensagem m = manipuladores.stream().filter(x -> x.tipo().equals(tipo)).findFirst().orElseThrow();
        new TransactionTemplate(transacoes).executeWithoutResult(s -> m.tratar(e));
    }

    private void receber(String tipo, long pedidoId) {
        receber(tipo, pedidoId, Map.of());
    }

    private String status(long id) {
        return repo.buscar(id).orElseThrow().status();
    }

    private List<String> mensagens(long pedidoId) {
        return jdbc.queryForList("SELECT type FROM outbox WHERE payload->'payload'->>'pedidoId' = ? ORDER BY id", String.class, String.valueOf(pedidoId));
    }

    private int historico(long id) {
        return jdbc.queryForObject("SELECT count(*) FROM historico WHERE pedido_id = ?", Integer.class, id);
    }

    // ---------------------------------------------------------------- fluxo feliz

    @Test
    void criarGravaORecebidoEOComandoNaOutboxNaMesmaTransacao() {
        long id = novoPedido("c1", true, false);
        assertEquals("RECEBIDO", status(id));
        assertEquals(List.of("estoque.reservar"), mensagens(id));
        assertEquals(1, historico(id));
    }

    @Test
    void reservadoVaiParaAguardandoPagamentoComPrazoEManda_cobrar() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);

        Pedido p = repo.buscar(id).orElseThrow();
        assertEquals("AGUARDANDO_PAGAMENTO", p.status());
        assertTrue(p.prazoPagamento().isAfter(Instant.now()));
        assertEquals(List.of("estoque.reservar", "pagamento.cobrar"), mensagens(id));
        String expiraEm = jdbc.queryForObject("SELECT payload->'payload'->>'expiraEm' FROM outbox WHERE type = 'pagamento.cobrar'", String.class);
        assertEquals(p.prazoPagamento(), Instant.parse(expiraEm));
    }

    @Test
    void esgotadoTerminaOPedido() {
        long id = novoPedido("c1", true, false);
        receber("estoque.esgotado", id);
        assertEquals("ESGOTADO", status(id));
        assertEquals(List.of("estoque.reservar"), mensagens(id));
    }

    @Test
    void aprovadoNoPrazoConfirmaEPublicaPedidoConfirmadoComDestino() {
        long id = novoPedido("operador", false, true);
        receber("estoque.reservado", id);
        receber("pagamento.aprovado", id, Map.of("referencia", "ref-1"));

        assertEquals("CONFIRMADO", status(id));
        assertEquals(List.of("estoque.reservar", "pagamento.cobrar", "pedido.confirmado"), mensagens(id));
        JsonNode envelope = Json.MAPPER.readTree(jdbc.queryForObject("SELECT payload::text FROM outbox WHERE type = 'pedido.confirmado'", String.class));
        assertEquals(2, envelope.get("version").asInt()); // o pedidos publica a v2
        JsonNode entrega = envelope.get("payload").get("entrega");
        assertEquals(-26.91, entrega.get("destino").get("lat").asDouble());
        assertEquals(2, entrega.get("entregadorPreferidoId").asInt());
    }

    @Test
    void pedidoDoQrConfirmaSemDestino() {
        long id = novoPedido("c-qr", true, false);
        receber("estoque.reservado", id);
        receber("pagamento.aprovado", id, Map.of("referencia", "ref-1"));

        assertEquals("CONFIRMADO", status(id));
        JsonNode entrega = Json.MAPPER.readTree(jdbc.queryForObject("SELECT payload::text FROM outbox WHERE type = 'pedido.confirmado'", String.class)).get("payload").get("entrega");
        assertTrue(entrega.get("destino").isNull());
        assertTrue(entrega.get("entregadorPreferidoId").isNull());
    }

    @Test
    void entregaAtribuidaEConcluidaLevamAoEntregue() {
        long id = novoPedido("operador", false, true);
        receber("estoque.reservado", id);
        receber("pagamento.aprovado", id, Map.of("referencia", "r"));
        receber("entrega.atribuida", id, Map.of("entregadorId", 2, "entregadorNome", "Sim"));
        assertEquals("EM_ENTREGA", status(id));
        assertEquals(2, repo.buscar(id).orElseThrow().entregadorId());

        receber("entrega.concluida", id, Map.of("entregadorId", 2, "modo", "geofence"));
        assertEquals("ENTREGUE", status(id));
        assertEquals(5, historico(id)); // RECEBIDO, AGUARDANDO_PAGAMENTO, CONFIRMADO, EM_ENTREGA, ENTREGUE
    }

    // ---------------------------------------------------------------- compensações

    @Test
    void pagamentoRecusadoCancelaEManda_pedidoCancelado() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        receber("pagamento.recusado", id, Map.of("motivo", "GATEWAY_FALHOU"));

        Pedido p = repo.buscar(id).orElseThrow();
        assertEquals("CANCELADO", p.status());
        assertEquals("PAGAMENTO_RECUSADO", p.motivo());
        assertEquals("pedido.cancelado", mensagens(id).get(mensagens(id).size() - 1));
    }

    @Test
    void prazoVencidoCancelaPeloAgendadorEManda_pedidoCancelado() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        jdbc.update("UPDATE pedidos SET prazo_pagamento = now() - interval '1 second' WHERE id = ?", id);

        assertEquals(1, agendador.cancelarVencidos());
        Pedido p = repo.buscar(id).orElseThrow();
        assertEquals("CANCELADO", p.status());
        assertEquals("PRAZO_EXPIRADO", p.motivo());
        assertEquals("pedido.cancelado", mensagens(id).get(mensagens(id).size() - 1));
        assertEquals(0, agendador.cancelarVencidos()); // não cancela duas vezes
    }

    @Test
    void f7_aprovacaoAtrasadaDepoisDoCancelamentoViraEstorno() {
        long id = novoPedido("operador", false, true);
        receber("estoque.reservado", id);
        jdbc.update("UPDATE pedidos SET prazo_pagamento = now() - interval '1 second' WHERE id = ?", id);
        agendador.cancelarVencidos(); // em 15 s: CANCELADO

        receber("pagamento.aprovado", id, Map.of("referencia", "atrasada")); // em 20 s: chega a aprovação
        assertEquals("CANCELADO", status(id));
        assertEquals("pagamento.estornar", mensagens(id).get(mensagens(id).size() - 1));

        receber("pagamento.estornado", id);
        assertEquals("ESTORNADO", status(id));
        assertFalse(mensagens(id).contains("pedido.confirmado"));
    }

    @Test
    void aprovacaoComPrazoVencidoMasAindaNaoCanceladoCancelaEEstorna() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        jdbc.update("UPDATE pedidos SET prazo_pagamento = now() - interval '1 second' WHERE id = ?", id);

        receber("pagamento.aprovado", id, Map.of("referencia", "r")); // o agendador ainda não rodou
        assertEquals("CANCELADO", status(id));
        List<String> m = mensagens(id);
        assertTrue(m.contains("pedido.cancelado"));
        assertEquals("pagamento.estornar", m.get(m.size() - 1));
    }

    @Test
    void recusadaPorPrazoExpiradoGuardaOMotivoCerto() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        receber("pagamento.recusado", id, Map.of("motivo", "PRAZO_EXPIRADO"));
        assertEquals("PRAZO_EXPIRADO", repo.buscar(id).orElseThrow().motivo());
    }

    // ---------------------------------------------------------------- corridas e mensagens fora de hora

    @Test
    void mensagemForaDeHoraNaoMudaNada() {
        long id = novoPedido("c1", true, false);
        int antes = historico(id);
        receber("entrega.concluida", id, Map.of("entregadorId", 1, "modo", "manual")); // RECEBIDO não conclui entrega
        receber("pagamento.aprovado", id, Map.of("referencia", "r")); // ninguém cobrou ainda
        receber("pagamento.estornado", id);
        assertEquals("RECEBIDO", status(id));
        assertEquals(antes, historico(id));
        assertEquals(List.of("estoque.reservar"), mensagens(id));
    }

    @Test
    void aprovacaoRepetidaNaoPublicaDuasVezesOConfirmado() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        receber("pagamento.aprovado", id, Map.of("referencia", "r"));
        receber("pagamento.aprovado", id, Map.of("referencia", "r"));
        assertEquals(1, mensagens(id).stream().filter("pedido.confirmado"::equals).count());
    }

    @Test
    void reservadoRepetidoNaoManda_cobrarDuasVezes() {
        long id = novoPedido("c1", true, false);
        receber("estoque.reservado", id);
        receber("estoque.reservado", id);
        assertEquals(1, mensagens(id).stream().filter("pagamento.cobrar"::equals).count());
    }

    // ---------------------------------------------------------------- limite do cliente do QR

    @Test
    void clienteDoQrTemNoMaximoUmPedidoEmAndamento() {
        novoPedido("cliente-a", true, false);
        assertThrows(PedidoServico.LimiteExcedidoException.class, () -> novoPedido("cliente-a", true, false));
        novoPedido("cliente-b", true, false); // outro cliente não é afetado
    }

    @Test
    void clienteVoltaAPoderPedirQuandoOPedidoTermina() {
        long id = novoPedido("cliente-a", true, false);
        receber("estoque.esgotado", id);
        novoPedido("cliente-a", true, false);
    }

    @Test
    void pedidosSimultaneosDoMesmoClienteNaoPassamJuntosPeloLimite() throws Exception {
        int[] criados = {0};
        Thread[] ts = new Thread[8];
        for (int i = 0; i < ts.length; i++) {
            ts[i] = new Thread(() -> {
                try {
                    novoPedido("cliente-corrida", true, false);
                    synchronized (criados) {
                        criados[0]++;
                    }
                } catch (PedidoServico.LimiteExcedidoException ignorada) {
                    // esperado para 7 das 8
                }
            });
            ts[i].start();
        }
        for (Thread t : ts) t.join();
        assertEquals(1, criados[0]);
    }

    // ---------------------------------------------------------------- API HTTP

    private HttpResponse<String> http(String metodo, String caminho, String corpo, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + porta + caminho));
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        if (corpo != null) b.header("Content-Type", "application/json");
        b.method(metodo, corpo == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(corpo));
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void postDoOperadorResponde202ComIdELocation() throws Exception {
        HttpResponse<String> r = http("POST", "/api/pedidos", "{\"destino\":{\"lat\":-26.9,\"lon\":-49.0,\"endereco\":\"Rua B\"},\"entregadorPreferidoId\":1}",
                "X-User-Id", "operador", "X-User-Role", "operador");
        assertEquals(202, r.statusCode());
        JsonNode j = Json.MAPPER.readTree(r.body());
        assertEquals("RECEBIDO", j.get("status").asString());
        long id = j.get("id").asLong();
        assertEquals("/api/pedidos/" + id, r.headers().firstValue("Location").orElse(""));
        assertEquals("RECEBIDO", status(id));
    }

    @Test
    void operadorSemDestinoRecebe400EEntregadorNaoCria() throws Exception {
        assertEquals(400, http("POST", "/api/pedidos", "{}", "X-User-Id", "operador", "X-User-Role", "operador").statusCode());
        assertEquals(403, http("POST", "/api/pedidos", null, "X-User-Id", "entregador1", "X-User-Role", "entregador").statusCode());
        assertEquals(401, http("POST", "/api/pedidos", null).statusCode());
    }

    @Test
    void clienteVeSoOsProprios_e409NoSegundoPedido() throws Exception {
        HttpResponse<String> r = http("POST", "/api/pedidos", null, "X-User-Id", "c-1", "X-User-Role", "cliente");
        assertEquals(202, r.statusCode());
        long id = Json.MAPPER.readTree(r.body()).get("id").asLong();

        assertEquals(200, http("GET", "/api/pedidos/" + id, null, "X-User-Id", "c-1", "X-User-Role", "cliente").statusCode());
        assertEquals(404, http("GET", "/api/pedidos/" + id, null, "X-User-Id", "c-2", "X-User-Role", "cliente").statusCode());
        assertEquals(200, http("GET", "/api/pedidos/" + id, null, "X-User-Id", "operador", "X-User-Role", "operador").statusCode());
        assertEquals(409, http("POST", "/api/pedidos", null, "X-User-Id", "c-1", "X-User-Role", "cliente").statusCode());
    }

    @Test
    void historicoELista() throws Exception {
        long id = novoPedido("operador", false, true);
        receber("estoque.reservado", id);
        JsonNode h = Json.MAPPER.readTree(http("GET", "/api/pedidos/" + id + "/historico", null, "X-User-Id", "operador", "X-User-Role", "operador").body());
        assertEquals(2, h.size());
        assertEquals("AGUARDANDO_PAGAMENTO", h.get(1).get("para").asString());
        assertTrue(h.get(1).get("correlationId").asString().length() > 10);

        assertEquals(200, http("GET", "/api/pedidos?ativos=true", null, "X-User-Id", "operador", "X-User-Role", "operador").statusCode());
        assertEquals(403, http("GET", "/api/pedidos", null, "X-User-Id", "c-1", "X-User-Role", "cliente").statusCode());
    }

    @Test
    void configDevolveOrigemEPromocao() throws Exception {
        JsonNode j = Json.MAPPER.readTree(http("GET", "/api/pedidos/config", null, "X-User-Id", "c-1", "X-User-Role", "cliente").body());
        assertEquals(-26.9194, j.get("origem").get("lat").asDouble());
    }
}
