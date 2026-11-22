// Página do cliente (QR code): entra com um apelido, pede a promoção (a entrega vai para onde ele está, pelo GPS do
// celular) e acompanha cada passo até o entregador chegar.
// Todo texto vindo do servidor entra por textContent. O telão nunca mostra o apelido, só o número do pedido.
(function () {
  const $ = (id) => document.getElementById(id);
  const parametros = new URLSearchParams(location.search);
  const CHAVE_PEDIDO = 'delivery.pedidoCliente';
  let timer = null;
  let timerEstoque = null;
  let origemLoja = null; // onde o mapa abre quando não há GPS
  let ultimoGps = null; // o último ponto que o GPS deu: o mapa abre por ali

  // o código do evento vem no link do QR (?codigo=...); sem ele, a pessoa digita
  const codigoDoLink = parametros.get('codigo');

  const guardado = (n) => { try { return localStorage.getItem(n); } catch (e) { return null; } };
  const guardar = (n, v) => { try { v === null ? localStorage.removeItem(n) : localStorage.setItem(n, v); } catch (e) { /* sem storage */ } };

  function tela(nome) {
    for (const t of ['entrar', 'pedir', 'escolher-local', 'acompanhar']) $(t).classList.toggle('oculto', t !== nome);
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
  // Pedido com endereço (o normal): recebido -> reservada -> pagando -> procurando entregador -> a caminho -> entregue.
  // Pedido sem endereço (link antigo, sem GPS): recebido -> reservada -> pagando -> confirmado.
  const PASSOS_ENTREGA = [
    { icone: '📝', texto: 'Pedido recebido' },
    { icone: '📦', texto: 'Unidade reservada para você' },
    { icone: '💳', texto: 'Pagando…' },
    { icone: '🔎', texto: 'Procurando um entregador…' },
    { icone: '🛵', texto: 'Entregador a caminho' },
    { icone: '🎉', texto: 'Entregue!' },
  ];
  const PASSOS_SIMPLES = [
    { icone: '📝', texto: 'Pedido recebido' },
    { icone: '📦', texto: 'Unidade reservada para você' },
    { icone: '💳', texto: 'Pagando…' },
    { icone: '🎉', texto: 'Pedido confirmado!' },
  ];

  // quantos passos já foram vencidos em cada status
  const ETAPA_ENTREGA = { RECEBIDO: 0, AGUARDANDO_PAGAMENTO: 2, CONFIRMADO: 3, EM_ENTREGA: 4, ENTREGUE: 6 };
  const ETAPA_SIMPLES = { RECEBIDO: 0, AGUARDANDO_PAGAMENTO: 2, CONFIRMADO: 4, EM_ENTREGA: 4, ENTREGUE: 4 };

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

    const comEntrega = !!p.destino;
    const PASSOS = comEntrega ? PASSOS_ENTREGA : PASSOS_SIMPLES;
    const ETAPA = comEntrega ? ETAPA_ENTREGA : ETAPA_SIMPLES;

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
    if (etapa >= PASSOS.length) {
      resultado.textContent = comEntrega ? 'Seu pedido chegou! 🎉' : 'Pronto! Seu pedido está garantido. 🎉';
      resultado.classList.add('ok');
      return true;
    }
    if (comEntrega && p.status === 'CONFIRMADO') resultado.textContent = 'Pagamento aprovado. Estamos chamando os entregadores…';
    if (comEntrega && p.status === 'EM_ENTREGA') resultado.textContent = 'Fique por aí: o entregador está indo até a sua localização.';
    return false;
  }

  // ---------------------------------------------------------------- acompanhar (polling a cada 1 s)
  // Por padrão lê do pedidos (Postgres). Bônus CQRS: com ?leitura=consultas na URL lê da visão separada (serviço
  // "consultas", DynamoDB), que é eventualmente consistente: se ela ainda não recebeu o pedido, cai para o pedidos.
  const LER_CONSULTAS = parametros.get('leitura') === 'consultas';

  async function lerPedido(id) {
    if (LER_CONSULTAS) {
      const r = await Auth.api('/api/consultas/pedidos/' + id);
      if (r.ok) return r;
    }
    return Auth.api('/api/pedidos/' + id);
  }

  function acompanhar(id) {
    guardar(CHAVE_PEDIDO, String(id));
    $('numero').textContent = '#' + id;
    $('de-novo').classList.add('oculto');
    $('outro-pedido').classList.remove('oculto');
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
          $('outro-pedido').classList.add('oculto');
          atualizarRestam();
        }
      } catch (e) { /* sem rede: tenta no próximo ciclo */ }
    };
    ciclo();
    timer = setInterval(ciclo, 1000);
  }

  // ---------------------------------------------------------------- onde entregar (GPS do celular ou toque no mapa)
  function localizar() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('Este aparelho não tem GPS.'));
      if (!window.isSecureContext) return reject(new Error('O GPS só funciona em páginas https://.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        (e) => reject(new Error(e.code === 1 ? 'A localização está bloqueada neste navegador.' : 'Não consegui pegar a sua localização.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
      );
    });
  }

  async function enviarPedido(destino) {
    const r = await Auth.api('/api/pedidos', { method: 'POST', body: { destino: { lat: destino.lat, lon: destino.lon } } });
    if (r.status === 409) throw new Error('Você já tem um pedido em andamento. Espere ele terminar.');
    if (r.status !== 202) throw new Error('Não consegui fazer o pedido agora. Tente de novo.');
    acompanhar((await r.json()).id);
  }

  async function pedir() {
    const erro = $('erro-pedir');
    erro.textContent = '';
    const botao = $('btn-pedir');
    botao.disabled = true;
    botao.textContent = 'Pegando sua localização…';
    try {
      let destino;
      try {
        destino = await localizar();
        ultimoGps = destino;
      } catch (e) {
        return mostrarMapaLocal(e.message + ' Toque no mapa onde você está.'); // sem GPS: a pessoa marca no mapa
      }
      await enviarPedido(destino);
    } catch (e) {
      erro.textContent = e.message;
    } finally {
      botao.disabled = false;
      botao.textContent = 'Quero um pedido!';
    }
  }

  // Um mapa para marcar onde entregar: sem GPS ou quando a pessoa quer receber em outro endereço
  let mapaLocal = null, marcadorLocal = null, pontoEscolhido = null;

  function marcarPonto(latlng) {
    pontoEscolhido = { lat: latlng.lat, lon: latlng.lng };
    $('btn-pedir-aqui').disabled = false;
    if (marcadorLocal) {
      marcadorLocal.setLatLng(latlng);
    } else {
      marcadorLocal = L.marker(latlng, { draggable: true }).addTo(mapaLocal); // dá para arrastar para ajustar
      marcadorLocal.on('dragend', () => marcarPonto(marcadorLocal.getLatLng()));
    }
  }

  function mostrarMapaLocal(texto) {
    $('motivo-local').textContent = texto;
    $('erro-local').textContent = '';
    // toda vez começa sem ponto marcado: a pessoa escolhe de novo (nada de voltar para o ponto do pedido anterior)
    pontoEscolhido = null;
    $('btn-pedir-aqui').disabled = true;
    if (marcadorLocal) { mapaLocal.removeLayer(marcadorLocal); marcadorLocal = null; }
    tela('escolher-local');
    const centro = ultimoGps || origemLoja;
    const ponto = centro ? [centro.lat, centro.lon] : [-26.9194, -49.0661];
    if (!mapaLocal) {
      mapaLocal = L.map('mapa-local').setView(ponto, 16);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapaLocal);
      mapaLocal.on('click', (ev) => marcarPonto(ev.latlng));
    } else {
      mapaLocal.setView(ponto, 16);
    }
    setTimeout(() => mapaLocal.invalidateSize(), 50); // o mapa estava escondido até agora
  }

  async function pedirNoPonto() {
    if (!pontoEscolhido) return;
    $('erro-local').textContent = '';
    $('btn-pedir-aqui').disabled = true;
    try {
      await enviarPedido(pontoEscolhido);
    } catch (e) {
      $('erro-local').textContent = e.message;
      $('btn-pedir-aqui').disabled = false;
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
  $('btn-outro-lugar').addEventListener('click', () => mostrarMapaLocal('Toque no mapa onde você quer receber o pedido. Dá para arrastar o marcador para ajustar.'));
  $('btn-pedir-aqui').addEventListener('click', pedirNoPonto);
  $('voltar-local').addEventListener('click', mostrarPedir);
  $('de-novo').addEventListener('click', mostrarPedir);
  $('outro-pedido').addEventListener('click', () => { // o pedido de antes segue o caminho dele; aqui a tela fica livre para outro
    clearInterval(timer);
    guardar(CHAVE_PEDIDO, null);
    mostrarPedir();
  });
  $('trocar').addEventListener('click', () => Auth.sair());

  // ---------------------------------------------------------------- início
  async function iniciarLogado() {
    try {
      const cfg = await (await Auth.api('/api/pedidos/config')).json();
      $('promo').textContent = cfg.promocao.nome;
      origemLoja = cfg.origem;
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
