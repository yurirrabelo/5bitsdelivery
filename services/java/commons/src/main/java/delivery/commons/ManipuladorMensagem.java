package delivery.commons;

import java.util.function.Consumer;

/**
 * Trata um tipo de mensagem. Roda na mesma transação da inbox: se lançar exceção, nada é gravado
 * (nem o messageId na inbox). Declare como @Bean/@Component e o consumidor registra sozinho.
 */
public interface ManipuladorMensagem {
    String tipo();

    void tratar(Envelope envelope);

    /** Atalho para criar um manipulador a partir de um método. */
    static ManipuladorMensagem de(String tipo, Consumer<Envelope> acao) {
        return new ManipuladorMensagem() {
            @Override
            public String tipo() {
                return tipo;
            }

            @Override
            public void tratar(Envelope envelope) {
                acao.accept(envelope);
            }
        };
    }
}
