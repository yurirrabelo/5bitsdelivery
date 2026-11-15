package delivery.commons;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class OutboxTest {
    static DataSource ds;
    static JdbcTemplate jdbc;
    static DataSourceTransactionManager transacoes;
    static CachingConnectionFactory conexoes;
    static RabbitTemplate rabbit;

    Outbox outbox;
    Ambiente.Topologia topo;
    PublicadorOutbox publicador;

    @BeforeAll
    static void iniciar() {
        ds = Ambiente.dataSource();
        Ambiente.migrar(ds);
        jdbc = new JdbcTemplate(ds);
        transacoes = new DataSourceTransactionManager(ds);
        conexoes = Ambiente.conexoes(Ambiente.AMQP_URL);
        rabbit = new RabbitTemplate(conexoes);
        jdbc.execute("CREATE TABLE IF NOT EXISTS efeitos (id SERIAL PRIMARY KEY, message_id UUID)");
    }

    @BeforeEach
    void preparar() {
        jdbc.execute("TRUNCATE outbox, mensagens_processadas, efeitos RESTART IDENTITY");
        outbox = new Outbox(jdbc);
        topo = Ambiente.Topologia.criar(rabbit, 2, "estoque.reservar");
        publicador = novoPublicador(rabbit);
    }

    @AfterEach
    void limpar() {
        topo.remover();
    }

    private PublicadorOutbox novoPublicador(RabbitTemplate r) {
        return new PublicadorOutbox(jdbc, transacoes, r, new Metricas(), topo.exchange(), 50, 200);
    }

    private int pendentes() {
        return jdbc.queryForObject("SELECT count(*) FROM outbox WHERE publicada_em IS NULL", Integer.class);
    }

    private void gravar(int pedidoId) {
        new TransactionTemplate(transacoes).executeWithoutResult(
                s -> outbox.publicar("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", pedidoId), null));
    }

    @Test
    void eAtomicaComOEfeito_rollbackNaoDeixaMensagem() {
        assertThrows(RuntimeException.class, () -> new TransactionTemplate(transacoes).executeWithoutResult(s -> {
            jdbc.update("INSERT INTO efeitos (message_id) VALUES (?)", UUID.randomUUID());
            outbox.publicar("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", 1), null);
            throw new RuntimeException("falha depois de gravar");
        }));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM outbox", Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM efeitos", Integer.class));
    }

    @Test
    void publicaAsPendentesUmaVezSoEMarcaComoPublicadas() {
        gravar(1);
        assertEquals(1, publicador.ciclo());
        assertEquals(0, publicador.ciclo());
        assertEquals(0, pendentes());
        assertEquals(1, topo.tamanho(topo.fila()));

        Message m = rabbit.receive(topo.fila(), 2000);
        assertNotNull(m);
        assertEquals("estoque.reservar", m.getMessageProperties().getReceivedRoutingKey());
        assertEquals("application/json", m.getMessageProperties().getContentType());
    }

    @Test
    void comOBrokerForaAsMensagensEsperamEAoVoltarSaemEmOrdem() throws Exception {
        CachingConnectionFactory fora = Ambiente.conexoes("amqp://teste:teste@localhost:1");
        PublicadorOutbox semBroker = novoPublicador(new RabbitTemplate(fora));
        for (int i = 1; i <= 3; i++) gravar(i);

        assertEquals(0, semBroker.ciclo());
        assertEquals(3, pendentes());

        assertEquals(3, publicador.ciclo());
        assertEquals(0, pendentes());
        for (int i = 1; i <= 3; i++) {
            Message m = rabbit.receive(topo.fila(), 2000);
            assertNotNull(m);
            assertTrue(new String(m.getBody()).contains("\"pedidoId\":" + i));
        }
    }

    @Test
    void guardaOTraceparentDoTraceAtivoERestauraAoPublicar() {
        SdkTracerProvider provider = SdkTracerProvider.builder().build();
        OpenTelemetrySdk sdk = OpenTelemetrySdk.builder().setTracerProvider(provider).build();
        Span span = sdk.getTracer("teste").spanBuilder("pedido").startSpan();
        String traceId = span.getSpanContext().getTraceId();
        try (Scope ignored = span.makeCurrent()) {
            gravar(1);
        }
        span.end();

        String guardado = jdbc.queryForObject("SELECT traceparent FROM outbox", String.class);
        assertNotNull(guardado);
        assertTrue(guardado.contains(traceId));

        // o publicador roda fora do trace original e mesmo assim mantém o mesmo trace nos headers AMQP
        publicador.ciclo();
        Message m = rabbit.receive(topo.fila(), 2000);
        assertNotNull(m);
        String header = (String) m.getMessageProperties().getHeaders().get("traceparent");
        assertNotNull(header);
        assertTrue(header.contains(traceId));
    }

    @Test
    void semTraceAtivoUsaOTraceparentPadrao() {
        String padrao = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
        new TransactionTemplate(transacoes).executeWithoutResult(
                s -> outbox.publicar("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", 1), padrao));
        assertEquals(padrao, jdbc.queryForObject("SELECT traceparent FROM outbox", String.class));
        assertNull(Trace.traceparentAtual());
    }
}
