package delivery.estoque;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Dados iniciais: o produto 1 é o item que o cliente pede, com ITEM_QUANTIDADE unidades. Criado só se não existir
 * (reiniciar o serviço não repõe o estoque; só o nome é atualizado). Roda antes de o consumidor começar a receber mensagens.
 */
@Component
public class SementeEstoque implements InitializingBean {
    public static final int PRODUTO = 1;

    private final JdbcTemplate jdbc;
    private final String nome;
    private final int quantidade;

    public SementeEstoque(
            JdbcTemplate jdbc,
            @Value("${ITEM_NOME:Item}") String nome,
            @Value("${ITEM_QUANTIDADE:10}") int quantidade) {
        this.jdbc = jdbc;
        this.nome = nome;
        this.quantidade = quantidade;
    }

    @Override
    public void afterPropertiesSet() {
        jdbc.update(
                "INSERT INTO estoque (produto_id, nome, total, disponivel) VALUES (?, ?, ?, ?) "
                        + "ON CONFLICT (produto_id) DO UPDATE SET nome = EXCLUDED.nome",
                PRODUTO, nome, quantidade, quantidade);
    }
}
