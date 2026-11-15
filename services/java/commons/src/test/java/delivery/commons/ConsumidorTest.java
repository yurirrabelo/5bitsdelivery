package delivery.commons;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ConsumidorTest {
    static DataSource ds;
    static JdbcTemplate jdbc;
    static DataSourceTransactionManager transacoes;
    static CachingConnectionFactory conexoes;
    static RabbitTemplate rabbit;
    static ContratoValidador validador;

    /** Guarda o que foi contado, para os testes conferirem. */
    static class MetricasTeste extends Metricas {
        final List<String> registros = new CopyOnWriteArrayList<>();

        @Override
        public void mensagem(String type, String resultado) {
            registros.add(resultado);
        }

        long conta(String resultado) {
            return registros.stream().filter(resultado::equals).count();
        }
    }

    Ambiente.Topologia topo;
    MetricasTeste metricas;
    EstadoSaude estado;
    AtomicInteger chamadas;
    ConsumidorMensagens consumidor;

    @BeforeAll
    static void iniciar() {
        ds = Ambiente.dataSource();
        Ambiente.migrar(ds);
        jdbc = new JdbcTemplate(ds);
        transacoes = new DataSourceTransactionManager(ds);
        conexoes = Ambiente.conexoes(Ambiente.AMQP_URL);
        rabbit = new RabbitTemplate(conexoes);
        validador = new ContratoValidador(Ambiente.dirContratos());
        jdbc.execute("CREATE TABLE IF NOT EXISTS efeitos (id SERIAL PRIMARY KEY, message_id UUID)");
    }

    @BeforeEach
    void preparar() {
        jdbc.execute("TRUNCATE outbox, mensagens_processadas, efeitos RESTART IDENTITY");
        topo = Ambiente.Topologia.criar(rabbit, 2, "estoque.reservar"); // limite 2 = MAX_TENTATIVAS (3) - 1
        metricas = new MetricasTeste();
        estado = new EstadoSaude();
        chamadas = new AtomicInteger();
    }

    @AfterEach
    void limpar() {
        if (consumidor != null) consumidor.stop();
        topo.remover();
    }

    /** Sobe um consumidor com um manipulador de estoque.reservar. O padrão grava um "efeito". */
    private void iniciarConsumidor(Consumer<Envelope> manipulador) {
        ManipuladorMensagem m = new ManipuladorMensagem() {
            @Override
            public String tipo() {
                return "estoque.reservar";
            }

            @Override
            public void tratar(Envelope e) {
                chamadas.incrementAndGet();
                if (manipulador != null) {
                    manipulador.accept(e);
                } else {
                    jdbc.update("INSERT INTO efeitos (message_id) VALUES (?)", UUID.fromString(e.messageId()));
                }
            }
        };
        consumidor = new ConsumidorMensagens(
                conexoes, topo.fila(), List.of(m), validador, new Inbox(jdbc), transacoes, estado, metricas, 50, 200);
        consumidor.start();
    }

    private String mensagem(int pedidoId) {
        return Json.MAPPER.writeValueAsString(Envelope.novo("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", pedidoId)));
    }

    private int contar(String tabela) {
        return jdbc.queryForObject("SELECT count(*) FROM " + tabela, Integer.class);
    }

    @Test
    void mesmaMensagemCincoVezes_umEfeitoQuatroDescartadas() {
        iniciarConsumidor(null);
        String repetida = mensagem(1);
        for (int i = 0; i < 5; i++) topo.publicar("estoque.reservar", repetida);
        // sentinela: o consumidor é único e em ordem, então quando ela passar as repetições já foram tratadas
        topo.publicar("estoque.reservar", mensagem(2));

        assertTrue(Ambiente.esperar(() -> contar("mensagens_processadas") == 2, 15000));
        assertEquals(2, contar("efeitos")); // a repetida (uma vez) + a sentinela
        assertEquals(4, metricas.conta("duplicada"));
        assertEquals(2, chamadas.get());
    }

    @Test
    void seOEfeitoFalha_aInboxNaoGuardaOMessageIdEANovaEntregaFunciona() {
        AtomicInteger tentativas = new AtomicInteger();
        iniciarConsumidor(e -> {
            jdbc.update("INSERT INTO efeitos (message_id) VALUES (?)", UUID.fromString(e.messageId()));
            if (tentativas.incrementAndGet() == 1) throw new IllegalStateException("falha no efeito, depois do INSERT");
        });
        topo.publicar("estoque.reservar", mensagem(1));

        assertTrue(Ambiente.esperar(() -> contar("mensagens_processadas") == 1, 15000));
        assertEquals(2, chamadas.get());
        assertEquals(1, contar("efeitos")); // o INSERT da primeira tentativa sofreu rollback
    }

    @Test
    void mensagemVenenosa_tresTentativasEDlqSemTravarAsOutras() {
        iniciarConsumidor(null);
        topo.publicar("estoque.reservar", "isto não é JSON");
        topo.publicar("estoque.reservar", mensagem(5));
        topo.publicar("estoque.reservar", mensagem(6));

        assertTrue(Ambiente.esperar(() -> topo.tamanho(topo.dlq()) == 1, 15000));
        assertTrue(Ambiente.esperar(() -> contar("mensagens_processadas") == 2, 15000));
        assertEquals(3, metricas.conta("erro"));
        assertEquals(2, chamadas.get()); // o manipulador nunca viu a venenosa
        assertEquals(2, contar("efeitos"));
    }

    @Test
    void payloadQueViolaOContratoTambemVaiParaADlq() {
        iniciarConsumidor(null);
        topo.publicar(
                "estoque.reservar",
                Json.MAPPER.writeValueAsString(Envelope.novo("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", "abc"))));
        assertTrue(Ambiente.esperar(() -> topo.tamanho(topo.dlq()) == 1, 15000));
        assertEquals(0, contar("efeitos"));
    }

    @Test
    void bancoFora_seguraAMensagemNaoMandaParaADlqEProcessaQuandoVolta() {
        AtomicInteger falhas = new AtomicInteger();
        iniciarConsumidor(e -> {
            if (falhas.getAndIncrement() < 3) throw new DataAccessResourceFailureException("connection refused");
            jdbc.update("INSERT INTO efeitos (message_id) VALUES (?)", UUID.fromString(e.messageId()));
        });
        topo.publicar("estoque.reservar", mensagem(1));

        assertTrue(Ambiente.esperar(estado::segurando, 15000)); // /health fica 503 enquanto segura
        assertTrue(Ambiente.esperar(() -> contar("mensagens_processadas") == 1, 15000));

        assertFalse(estado.segurando());
        assertEquals(0, metricas.conta("erro"));
        assertEquals(0, topo.tamanho(topo.dlq()));
        assertEquals(1, contar("efeitos"));
    }

    @Test
    void pontaAPonta_outboxRabbitInboxEfeito() {
        iniciarConsumidor(null);
        PublicadorOutbox publicador = new PublicadorOutbox(jdbc, transacoes, rabbit, new Metricas(), topo.exchange(), 50, 200);
        new TransactionTemplate(transacoes).executeWithoutResult(
                s -> new Outbox(jdbc).publicar("estoque.reservar", UUID.randomUUID().toString(), Map.of("pedidoId", 42), null));

        assertEquals(1, publicador.ciclo());
        assertTrue(Ambiente.esperar(() -> contar("efeitos") == 1, 15000));
        assertEquals(1, chamadas.get());
    }
}
