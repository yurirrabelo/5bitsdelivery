package delivery.estoque;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Dados iniciais: o produto 1 é a promoção, com PROMOCAO_QUANTIDADE unidades. Criado só se não existir
 * (reiniciar o serviço não repõe o estoque). Roda antes de o consumidor começar a receber mensagens.
 */
@Component
public class SementeEstoque implements InitializingBean {
    public static final int PRODUTO = 1;

    private final JdbcTemplate jdbc;
    private final String nome;
    private final int quantidade;

    public SementeEstoque(
            JdbcTemplate jdbc,
            @Value("${PROMOCAO_NOME:Promoção relâmpago}") String nome,
            @Value("${PROMOCAO_QUANTIDADE:10}") int quantidade) {
        this.jdbc = jdbc;
        this.nome = nome;
        this.quantidade = quantidade;
    }

    @Override
    public void afterPropertiesSet() {
        jdbc.update(
                "INSERT INTO estoque (produto_id, nome, total, disponivel) VALUES (?, ?, ?, ?) ON CONFLICT (produto_id) DO NOTHING",
                PRODUTO, nome, quantidade, quantidade);
    }
}
