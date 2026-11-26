package delivery.estoque;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Dados iniciais: o item que o cliente pede tem ITEM_QUANTIDADE unidades no total (30). Desses, PROMOCAO_QUANTIDADE (10) só
 * saem para quem pede com o cupom (produto 2); os outros são os itens normais (produto 1). Criados só se não existirem
 * (reiniciar o serviço não repõe o estoque; só o nome é atualizado). Roda antes de o consumidor começar a receber mensagens.
 */
@Component
public class SementeEstoque implements InitializingBean {
    public static final int PRODUTO = 1; // itens normais (pedido sem cupom)
    public static final int PRODUTO_CUPOM = 2; // itens com cupom

    private final JdbcTemplate jdbc;
    private final String nome;
    private final int quantidade;
    private final int comCupom;

    public SementeEstoque(
            JdbcTemplate jdbc,
            @Value("${ITEM_NOME:Item}") String nome,
            @Value("${ITEM_QUANTIDADE:30}") int quantidade,
            @Value("${PROMOCAO_QUANTIDADE:10}") int promocao) {
        this.jdbc = jdbc;
        this.nome = nome;
        this.quantidade = quantidade;
        this.comCupom = Math.max(0, Math.min(promocao, quantidade));
    }

    @Override
    public void afterPropertiesSet() {
        semear(PRODUTO, nome, quantidade - comCupom);
        semear(PRODUTO_CUPOM, nome + " (com cupom)", comCupom);
    }

    private void semear(int produto, String nomeDoProduto, int unidades) {
        jdbc.update(
                "INSERT INTO estoque (produto_id, nome, total, disponivel) VALUES (?, ?, ?, ?) "
                        + "ON CONFLICT (produto_id) DO UPDATE SET nome = EXCLUDED.nome",
                produto, nomeDoProduto, unidades, unidades);
    }
}
