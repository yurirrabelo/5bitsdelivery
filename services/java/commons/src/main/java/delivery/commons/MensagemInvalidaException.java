package delivery.commons;

/** Erro da mensagem em si (JSON inválido, contrato violado): vai para a DLQ após MAX_TENTATIVAS. */
public class MensagemInvalidaException extends RuntimeException {
    public MensagemInvalidaException(String mensagem) {
        super(mensagem);
    }
}
