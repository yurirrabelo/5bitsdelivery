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
}
