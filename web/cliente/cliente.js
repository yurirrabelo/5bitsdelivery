// Página do cliente (QR code): entra com um apelido, faz um pedido da promoção e acompanha cada passo.
// Todo texto vindo do servidor entra por textContent. O telão nunca mostra o apelido, só o número do pedido.
(function () {
  const $ = (id) => document.getElementById(id);
  const parametros = new URLSearchParams(location.search);
  const CHAVE_PEDIDO = 'delivery.pedidoCliente';
  let timer = null;
  let timerEstoque = null;

  // o código do evento vem no link do QR (?codigo=...); sem ele, a pessoa digita
  const codigoDoLink = parametros.get('codigo');

  const guardado = (n) => { try { return localStorage.getItem(n); } catch (e) { return null; } };
  const guardar = (n, v) => { try { v === null ? localStorage.removeItem(n) : localStorage.setItem(n, v); } catch (e) { /* sem storage */ } };

  function tela(nome) {
    for (const t of ['entrar', 'pedir', 'acompanhar']) $(t).classList.toggle('oculto', t !== nome);
  }

  // ---------------------------------------------------------------- quantas unidades restam
  async function atualizarRestam() {
    try {
      const r = await Auth.api('/api/estoque');
      if (!r.ok) return;
      const e = await r.json();
      $('restam').classList.remove('oculto');
      $('restam-n').textContent = e.disponivel + (e.disponivel === 1 ? ' unidade' : ' unidades');
      $('restam-total').textContent = e.total;
      $('restam-barra').style.width = (e.total ? (100 * e.disponivel) / e.total : 0) + '%';
    } catch (e) { /* sem rede: mantém o último valor */ }
  }

  // ---------------------------------------------------------------- passos de cada status
  // O caminho feliz: recebido -> unidade reservada -> pagando -> confirmado.
  const PASSOS = [
    { icone: '📝', texto: 'Pedido recebido' },
    { icone: '📦', texto: 'Unidade reservada para você' },
    { icone: '💳', texto: 'Pagando…' },
    { icone: '🎉', texto: 'Pedido confirmado!' },
  ];

  // quantos passos já foram vencidos em cada status
  const ETAPA = { RECEBIDO: 0, AGUARDANDO_PAGAMENTO: 2, CONFIRMADO: 4, EM_ENTREGA: 4, ENTREGUE: 4 };

  function desenhar(p) {
    const ol = $('passos');
    const resultado = $('resultado');
    ol.innerHTML = '';
    resultado.textContent = '';
    resultado.className = 'resultado';

    const item = (icone, texto, classe) => {
      const li = document.createElement('li');
      li.className = classe;
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = icone;
      const tx = document.createElement('span');
      tx.textContent = texto;
      li.append(ic, tx);
      ol.appendChild(li);
    };

    const falha = {
      ESGOTADO: ['😕', 'Acabaram as unidades', 'A promoção esgotou antes do seu pedido.'],
      CANCELADO: p.motivo === 'PRAZO_EXPIRADO'
        ? ['⏱️', 'O pagamento demorou demais', 'Cancelamos o pedido e devolvemos a unidade.']
        : ['❌', 'Pagamento recusado', 'Cancelamos o pedido e devolvemos a unidade.'],
      ESTORNADO: ['↩️', 'Pagamento estornado', 'O pagamento chegou atrasado e foi devolvido. Pode tentar de novo.'],
    }[p.status];

    if (falha) {
      // mostra por onde o pedido passou e onde ele parou
      const passou = p.status === 'ESGOTADO' ? 1 : 2;
      PASSOS.slice(0, passou).forEach((s) => item(s.icone, s.texto, 'feito'));
      item(falha[0], falha[1], 'falhou');
      resultado.textContent = falha[2];
      resultado.classList.add('ruim');
      return true;
    }

    const etapa = ETAPA[p.status] ?? 0;
    PASSOS.forEach((s, i) => item(s.icone, s.texto, i < etapa ? 'feito' : i === etapa ? 'atual' : ''));
    if (etapa >= 4) {
      resultado.textContent = 'Pronto! Seu pedido está garantido. 🎉';
      resultado.classList.add('ok');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- acompanhar (polling a cada 1 s)
  // CQRS: a leitura vem da visão (serviço "consultas", eventualmente consistente). Se ela não está no ar ou
  // ainda não recebeu o pedido (pode atrasar alguns milissegundos), cai para o pedidos, que é sempre correto.
  async function lerPedido(id) {
    try {
      const r = await Auth.api('/api/consultas/pedidos/' + id);
      if (r.ok) return r;
    } catch (e) { /* visão fora do ar */ }
    return Auth.api('/api/pedidos/' + id);
  }

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
          atualizarRestam();
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
    atualizarRestam();
  }

  // ---------------------------------------------------------------- entrar
  $('form-entrar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const erro = $('erro-entrar');
    erro.textContent = '';
    try {
      await Auth.entrarComoCliente($('apelido').value.trim(), codigoDoLink || $('codigo').value.trim());
      iniciarLogado();
    } catch (e) {
      erro.textContent = e.message;
    }
  });

  $('btn-pedir').addEventListener('click', pedir);
  $('de-novo').addEventListener('click', mostrarPedir);
  $('trocar').addEventListener('click', () => Auth.sair());

  // ---------------------------------------------------------------- início
  async function iniciarLogado() {
    try {
      const cfg = await (await Auth.api('/api/pedidos/config')).json();
      $('promo').textContent = cfg.promocao.nome;
    } catch (e) { /* mantém o título padrão */ }
    clearInterval(timerEstoque);
    timerEstoque = setInterval(atualizarRestam, 3000); // o contador da promoção anda sozinho
    const pedido = guardado(CHAVE_PEDIDO); // retoma o acompanhamento depois de recarregar a página
    if (pedido) acompanhar(pedido);
    else mostrarPedir();
  }

  (async function iniciar() {
    const u = Auth.usuario();
    if (u && u.role === 'cliente') return iniciarLogado();

    // Veio pelo QR (o código está no link): entra sozinho como visitante e já mostra o botão de pedir.
    // Sem o código no link, a pessoa digita o apelido e o código.
    if (codigoDoLink) {
      try {
        await Auth.entrarComoCliente('Visitante ' + (100 + Math.floor(Math.random() * 900)), codigoDoLink);
        return iniciarLogado();
      } catch (e) { /* código inválido: cai para o formulário */ }
    }
    if (!codigoDoLink) $('linha-codigo').classList.remove('oculto');
    tela('entrar');
  })();
})();
