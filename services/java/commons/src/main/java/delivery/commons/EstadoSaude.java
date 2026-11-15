package delivery.commons;

import java.util.concurrent.atomic.AtomicBoolean;

/** Compartilhado com o /health: true enquanto o consumidor segura uma mensagem por falha de infraestrutura. */
public class EstadoSaude {
    private final AtomicBoolean segurando = new AtomicBoolean();

    public boolean segurando() {
        return segurando.get();
    }

    public void segurando(boolean valor) {
        segurando.set(valor);
    }
}
