// Painel do operador: mapa ao vivo (WebSocket), criação de pedidos, lista, estoque e QR code.
// Todo texto vindo do servidor entra na tela por textContent ou escapado (Auth.escapar).
(function () {
  const $ = (id) => document.getElementById(id);

  function mostrarApp(u) {
    $('login').classList.add('oculto');
    $('app').classList.remove('oculto');
    $('quem').textContent = u.nome;
    iniciar();
  }

  $('sair').addEventListener('click', () => Auth.sair());
  const u = Auth.usuario();
  if (u && u.role === 'operador') mostrarApp(u);
  else {
    $('login').classList.remove('oculto');
    Auth.montarLogin($('login'), ['operador'], mostrarApp, {
      icone: '🎛️', titulo: 'Painel do operador', subtitulo: 'Crie pedidos, acompanhe o mapa ao vivo e controle a promoção.',
      botao: 'Entrar no painel', rotuloUsuario: 'Usuário do operador',
    });
  }

  // ---------------------------------------------------------------- estado
  let mapa, loja, destinoEscolhido, marcadorDestino;
  const entregadores = {}; // id -> {marcador, nome}
  const rastros = {}; // pedidoId -> {linha, pontos}
  const destinos = {}; // pedidoId -> marcador do destino
  let ultimaPosicaoEm = null;
  let ws, wsTentativas = 0;

  async function iniciar() {
    $('grafana').href = 'http://localhost:3000'; // o Grafana só abre no notebook, mesmo com o painel aberto pelo túnel

    const cfg = await (await Auth.api('/api/pedidos/config')).json();
    $('promo-nome').textContent = cfg.promocao.nome;

    mapa = L.map('mapa').setView([cfg.origem.lat, cfg.origem.lon], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(mapa);
    loja = L.marker([cfg.origem.lat, cfg.origem.lon]).addTo(mapa).bindTooltip(cfg.origem.nome, { permanent: true, direction: 'top', className: 'rotulo' });

    // clique no mapa define o destino do próximo pedido
    mapa.on('click', (e) => {
      destinoEscolhido = e.latlng;
      if (marcadorDestino) marcadorDestino.setLatLng(e.latlng);
      else marcadorDestino = L.marker(e.latlng, { opacity: 0.7 }).addTo(mapa);
      $('destino-info').textContent = 'Destino: ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
      $('criar').disabled = false;
    });

    $('criar').addEventListener('click', criarPedido);
    // modo telão: esconde os formulários e deixa só o que a turma precisa ver
    $('telao').addEventListener('click', () => {
      const ligado = document.body.classList.toggle('telao');
      $('telao').textContent = ligado ? '↩️ Sair do modo telão' : '📺 Modo telão';
      setTimeout(() => mapa.invalidateSize(), 50); // o mapa muda de largura
    });
    configurarQr();
    await atualizarEntregadores();
    conectarWs();
    atualizarLista();
    setInterval(atualizarLista, 2000); // pedidos e estoque: polling a cada 2 s
    setInterval(atualizarBarra, 1000);
  }

  // ---------------------------------------------------------------- criar pedido
  async function criarPedido() {
    const erro = $('criar-erro');
    erro.textContent = '';
    if (!destinoEscolhido) return;
    $('criar').disabled = true;
    const corpo = { destino: { lat: destinoEscolhido.lat, lon: destinoEscolhido.lng } };
    const pref = $('entregador').value;
    if (pref) corpo.entregadorPreferidoId = Number(pref);
    try {
      const r = await Auth.api('/api/pedidos', { method: 'POST', body: corpo });
      if (r.status !== 202) throw new Error('Não consegui criar o pedido (' + r.status + ').');
      const j = await r.json();
      erro.textContent = '';
      $('destino-info').textContent = 'Pedido #' + j.id + ' criado. Clique no mapa para o próximo.';
      if (marcadorDestino) { mapa.removeLayer(marcadorDestino); marcadorDestino = null; }
      destinoEscolhido = null;
      atualizarLista();
    } catch (e) {
      erro.textContent = e.message;
      $('criar').disabled = false;
    }
  }

  // ---------------------------------------------------------------- lista de pedidos e estoque
  // Por padrão a lista vem do pedidos (Postgres). Bônus CQRS: com ?leitura=consultas na URL ela vem da visão
  // separada (serviço "consultas", DynamoDB, eventualmente consistente).
  const LER_CONSULTAS = new URLSearchParams(location.search).get('leitura') === 'consultas';

  async function listarPedidos() {
    const r = await Auth.api(LER_CONSULTAS ? '/api/consultas/pedidos' : '/api/pedidos');
    return r.ok ? r.json() : null;
  }

  async function atualizarLista() {
    try {
      const [lista, re] = await Promise.all([listarPedidos(), Auth.api('/api/estoque')]);
      if (lista) renderPedidos(lista);
      if (re.ok) renderEstoque(await re.json());
    } catch (e) { /* servidor fora: tenta no próximo ciclo */ }
  }

  function renderPedidos(lista) {
    const tbody = $('pedidos');
    // telão: só o número e o status de cada pedido, nunca o apelido de quem pediu
    tbody.innerHTML = lista.slice(0, 15).map((p) =>
      '<tr><td>#' + Auth.escapar(p.id) + '</td><td><span class="badge ' + Auth.escapar(p.status) + '">' + Auth.escapar(p.status.replace('_', ' ')) +
      '</span></td><td>' + (p.entregadorId ? Auth.escapar(p.entregadorId) : '–') + '</td></tr>').join('');

    // destinos dos pedidos que ainda têm entrega pela frente
    for (const p of lista) {
      const ativo = p.destino && (p.status === 'CONFIRMADO' || p.status === 'EM_ENTREGA');
      if (ativo && !destinos[p.id]) {
        destinos[p.id] = L.circleMarker([p.destino.lat, p.destino.lon], { radius: 8, color: '#e8590c', fillOpacity: 0.3 })
          .addTo(mapa).bindTooltip('#' + p.id, { className: 'rotulo' });
      } else if (!ativo && destinos[p.id]) {
        mapa.removeLayer(destinos[p.id]);
        delete destinos[p.id];
      }
    }
  }

  function renderEstoque(e) {
    const caixa = (n, rotulo) => '<div><b>' + Auth.escapar(n) + '</b><span>' + rotulo + '</span></div>';
    $('estoque').innerHTML = caixa(e.disponivel, 'disponíveis') + caixa(e.reservado, 'reservadas') + caixa(e.vendido, 'vendidas') + caixa(e.total, 'total');
  }

  // ---------------------------------------------------------------- entregadores e mapa ao vivo
  async function atualizarEntregadores() {
    const r = await Auth.api('/api/entregas/entregadores');
    if (!r.ok) return;
    const lista = await r.json();
    const sel = $('entregador');
    const atual = sel.value;
    sel.innerHTML = '<option value="">Qualquer (o mais próximo)</option>' +
      lista.map((e) => '<option value="' + Auth.escapar(e.id) + '">' + Auth.escapar(e.nome) + ' (' + Auth.escapar(e.status.toLowerCase()) + ')</option>').join('');
    sel.value = atual;
    lista.forEach((e) => { if (e.ultimaPosicao) moverEntregador(e.id, e.nome, e.ultimaPosicao.lat, e.ultimaPosicao.lon, null); });
  }

  function moverEntregador(id, nome, lat, lon, pedidoId) {
    let e = entregadores[id];
    if (!e) {
      const icone = L.divIcon({ className: 'icone-entregador', html: '🛵', iconSize: [28, 28], iconAnchor: [14, 14] });
      e = entregadores[id] = { nome: nome || 'Entregador ' + id, marcador: L.marker([lat, lon], { icon: icone, zIndexOffset: 1000 }).addTo(mapa) };
      e.marcador.bindTooltip(e.nome, { direction: 'top', offset: [0, -14], className: 'rotulo' });
    } else {
      e.marcador.setLatLng([lat, lon]);
    }
    if (pedidoId) {
      const r = rastros[pedidoId] || (rastros[pedidoId] = { pontos: [], linha: L.polyline([], { color: '#e8590c', weight: 4 }).addTo(mapa) });
      r.pontos.push([lat, lon]);
      r.linha.setLatLngs(r.pontos);
    }
  }

  async function carregarRastro(pedidoId) {
    if (rastros[pedidoId]) return;
    const r = await Auth.api('/api/entregas/' + pedidoId + '/rota');
    if (!r.ok) return;
    const rota = await r.json();
    const pontos = rota.geometry.coordinates.map((c) => [c[1], c[0]]);
    rastros[pedidoId] = { pontos, linha: L.polyline(pontos, { color: '#e8590c', weight: 4 }).addTo(mapa) };
  }

  function conectarWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws/entregas?token=' + encodeURIComponent(Auth.token()));
    ws.onopen = () => { wsTentativas = 0; barraWs(true); };
    ws.onclose = () => {
      barraWs(false);
      setTimeout(conectarWs, Math.min(1000 * ++wsTentativas, 10000)); // reconecta sozinho
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'snapshot') {
        m.entregadores.forEach((e) => { if (e.ultimaPosicao) moverEntregador(e.id, e.nome, e.ultimaPosicao.lat, e.ultimaPosicao.lon, null); });
        m.entregasAtivas.forEach((a) => carregarRastro(a.pedidoId));
      } else if (m.type === 'posicao') {
        ultimaPosicaoEm = Date.now();
        moverEntregador(m.entregadorId, null, m.lat, m.lon, m.pedidoId);
      } else if (m.type === 'entrega') {
        atualizarEntregadores();
        atualizarLista();
      }
    };
  }

  function barraWs(ok) {
    $('ws-status').className = 'ponto ' + (ok ? 'bom' : 'ruim');
    $('ws-texto').textContent = ok ? 'mapa ao vivo conectado' : 'mapa desconectado, reconectando…';
  }

  function atualizarBarra() {
    $('ultima-posicao').textContent = ultimaPosicaoEm
      ? 'última posição há ' + Math.round((Date.now() - ultimaPosicaoEm) / 1000) + ' s'
      : 'sem posições ainda';
  }

  // ---------------------------------------------------------------- QR code
  // O QR usa a origem da página: abra o painel pela URL do túnel no telão ou cole a URL pública no campo.
  async function configurarQr() {
    const r = await Auth.api('/api/auth/evento');
    if (!r.ok) return;
    const codigo = (await r.json()).codigo;
    const campo = $('url-publica');
    try { campo.value = localStorage.getItem('delivery.urlPublica') || ''; } catch (e) { /* sem storage */ }
    const desenhar = () => {
      const base = (campo.value.trim() || location.origin).replace(/\/+$/, '');
      const url = base + '/cliente/?codigo=' + encodeURIComponent(codigo);
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('qr').innerHTML = qr.createImgTag(6, 8);
      $('qr-link').textContent = url;
      $('link-entregador').textContent = base + '/entregador/';
      try { localStorage.setItem('delivery.urlPublica', campo.value.trim()); } catch (e) { /* sem storage */ }
    };
    campo.addEventListener('input', desenhar);
    desenhar();
  }
})();
