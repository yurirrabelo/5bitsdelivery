package delivery.pedidos;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Parâmetros de negócio, todos vindos do ambiente (.env). */
@Component
public class RegrasPedidos {
    @Value("${PRAZO_PAGAMENTO_SEG:15}")
    int prazoPagamentoSeg;

    @Value("${CLIENTE_PEDIDOS_EM_ANDAMENTO:1}")
    int limiteClienteEmAndamento;

    @Value("${ORIGEM_NOME:Loja}")
    String origemNome;

    @Value("${ORIGEM_LAT}")
    double origemLat;

    @Value("${ORIGEM_LON}")
    double origemLon;

    /** O item que o cliente pede (só o nome que aparece nas telas). */
    @Value("${ITEM_NOME:Item}")
    String itemNome;

    /** O cupom (sem o #). O cliente escreve #promobcc; vale com ou sem o #, em maiúsculas ou minúsculas. Com ele, o pedido usa um item com cupom. */
    @Value("${PROMOCAO_CUPOM:promobcc}")
    String promocaoCupom;

    boolean cupomValido(String digitado) {
        return normalizar(digitado).equals(normalizar(promocaoCupom));
    }

    private static String normalizar(String cupom) {
        String s = cupom == null ? "" : cupom.strip().toLowerCase();
        return s.startsWith("#") ? s.substring(1).strip() : s;
    }
}
