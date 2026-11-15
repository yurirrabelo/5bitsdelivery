// Página do cliente (QR code): entra com um apelido, faz um pedido da promoção e acompanha cada passo.
// Todo texto vindo do servidor entra por textContent. O telão nunca mostra o apelido, só o número do pedido.
(function () {
  const $ = (id) => document.getElementById(id);
  const parametros = new URLSearchParams(location.search);
  const CHAVE_PEDIDO = 'delivery.pedidoCliente';
  let timer = null;

  // o código do evento vem no link do QR (?codigo=...); sem ele, a pessoa digita
  const codigoDoLink = parametros.get('codigo');

  const guardado = (n) => { try { return localStorage.getItem(n); } catch (e) { return null; } };
  const guardar = (n, v) => { try { v === null ? localStorage.removeItem(n) : localStorage.setItem(n, v); } catch (e) { /* sem storage */ } };

  function tela(nome) {
    for (const t of ['entrar', 'pedir', 'acompanhar']) $(t).classList.toggle('oculto', t !== nome);
  }

  // ---------------------------------------------------------------- passos de cada status
  // O caminho feliz: recebido -> unidade reservada -> pagando -> confirmado.
  const PASSOS = ['Pedido recebido', 'Unidade reservada para você', 'Pagando…', 'Pedido confirmado!'];

  // quantos passos já foram vencidos em cada status
  const ETAPA = { RECEBIDO: 0, AGUARDANDO_PAGAMENTO: 2, CONFIRMADO: 4, EM_ENTREGA: 4, ENTREGUE: 4 };

  function desenhar(p) {
    const ol = $('passos');
    const resultado = $('resultado');
    ol.innerHTML = '';
    resultado.textContent = '';
    resultado.className = 'resultado';

    const item = (texto, classe) => {
      const li = document.createElement('li');
      li.textContent = texto;
      li.className = classe;
      ol.appendChild(li);
    };

    const falha = {
      ESGOTADO: ['Acabaram as unidades 😕', 'A promoção esgotou antes do seu pedido.'],
      CANCELADO: p.motivo === 'PRAZO_EXPIRADO'
        ? ['O pagamento demorou demais', 'Cancelamos o pedido e devolvemos a unidade.']
        : ['Pagamento recusado', 'Cancelamos o pedido e devolvemos a unidade.'],
      ESTORNADO: ['Pagamento estornado', 'O pagamento chegou atrasado e foi devolvido. Pode tentar de novo.'],
    }[p.status];

    if (falha) {
      // mostra por onde o pedido passou e onde ele parou
      const passou = p.status === 'ESGOTADO' ? 1 : 2;
      PASSOS.slice(0, passou).forEach((t) => item(t, 'feito'));
      item(falha[0], 'falhou');
      resultado.textContent = falha[1];
      resultado.classList.add('ruim');
      return true;
    }

    const etapa = ETAPA[p.status] ?? 0;
    PASSOS.forEach((t, i) => item(t, i < etapa ? 'feito' : i === etapa ? 'atual' : ''));
    if (etapa >= 4) {
      resultado.textContent = 'Pronto! Seu pedido está garantido. 🎉';
      resultado.classList.add('ok');
      return true;
    }
    return false;
  }

  // CQRS: a leitura vem da visão (serviço "consultas", eventualmente consistente). Se ela não está no ar ou
  // ainda não recebeu o pedido (pode atrasar alguns milissegundos), cai para o pedidos, que é sempre correto.
  async function lerPedido(id) {
    try {
      const r = await Auth.api('/api/consultas/pedidos/' + id);
      if (r.ok) return r;
    } catch (e) { /* visão fora do ar */ }
    return Auth.api('/api/pedidos/' + id);
  }

  // ---------------------------------------------------------------- acompanhar (polling a cada 1 s)
  function acompanhar(id) {
    guardar(CHAVE_PEDIDO, String(id));
    $('numero').textContent = '#' + id;
    $('de-novo').classList.add('oculto');
    tela('acompanhar');
    clearInterval(timer);

    const ciclo = async () => {
      try {
        const r = await lerPedido(id);
        if (r.status === 404) { guardar(CHAVE_PEDIDO, null); clearInterval(timer); return mostrarPedir(); }
        if (!r.ok) return;
        const fim = desenhar(await r.json());
        if (fim) {
          clearInterval(timer);
          guardar(CHAVE_PEDIDO, null);
          $('de-novo').classList.remove('oculto');
        }
      } catch (e) { /* sem rede: tenta no próximo ciclo */ }
    };
    ciclo();
    timer = setInterval(ciclo, 1000);
  }

  // ---------------------------------------------------------------- pedir
  async function pedir() {
    const erro = $('erro-pedir');
    erro.textContent = '';
    $('btn-pedir').disabled = true;
    try {
      const r = await Auth.api('/api/pedidos', { method: 'POST' });
      if (r.status === 409) throw new Error('Você já tem um pedido em andamento. Espere ele terminar.');
      if (r.status !== 202) throw new Error('Não consegui fazer o pedido agora. Tente de novo.');
      acompanhar((await r.json()).id);
    } catch (e) {
      erro.textContent = e.message;
    } finally {
      $('btn-pedir').disabled = false;
    }
  }

  function mostrarPedir() {
    $('nome').textContent = Auth.usuario().nome; // textContent: o apelido nunca é interpretado como HTML
    tela('pedir');
  }

  // ---------------------------------------------------------------- entrar
  $('form-entrar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const erro = $('erro-entrar');
    erro.textContent = '';
    try {
      await Auth.entrarComoCliente($('apelido').value.trim(), codigoDoLink || $('codigo').value.trim());
      mostrarPedir();
    } catch (e) {
      erro.textContent = e.message;
    }
  });

  $('btn-pedir').addEventListener('click', pedir);
  $('de-novo').addEventListener('click', mostrarPedir);
  $('trocar').addEventListener('click', () => Auth.sair());

  // ---------------------------------------------------------------- início
  (async function iniciar() {
    const u = Auth.usuario();
    if (u && u.role === 'cliente') {
      try {
        const cfg = await (await Auth.api('/api/pedidos/config')).json();
        $('promo').textContent = cfg.promocao.nome;
      } catch (e) { /* mantém o título padrão */ }
      const pedido = guardado(CHAVE_PEDIDO); // retoma o acompanhamento depois de recarregar a página
      if (pedido) acompanhar(pedido);
      else mostrarPedir();
    } else {
      if (!codigoDoLink) $('linha-codigo').classList.remove('oculto');
      tela('entrar');
    }
  })();
})();
