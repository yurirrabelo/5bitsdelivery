package delivery.commons;

/**
 * Trata um tipo de mensagem. Roda na mesma transação da inbox: se lançar exceção, nada é gravado
 * (nem o messageId na inbox). Declare como @Component e o consumidor registra sozinho.
 */
public interface ManipuladorMensagem {
    String tipo();

    void tratar(Envelope envelope);
}
