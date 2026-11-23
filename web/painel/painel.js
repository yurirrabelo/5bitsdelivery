// Painel de gestão: a central da loja. Acompanha ao vivo as entregas (o GPS dos entregadores no mapa), os pedidos dos
// clientes e o estoque da promoção, mostra o QR para a plateia pedir e deixa fazer um pedido manualmente pelo mapa.
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
      icone: '🎛️', titulo: 'Painel de gestão', subtitulo: 'Acompanhe as entregas, os pedidos e a promoção ao vivo.',
      botao: 'Entrar no painel', rotuloUsuario: 'Usuário da gestão',
    });
  }

  // ---------------------------------------------------------------- estado
  let mapa, loja, destinoEscolhido, marcadorDestino;
  let modoCriar = false; // "Pedido pelo mapa" ligado: o clique no mapa escolhe o destino
  let listaEntregadores = []; // da API: id, nome, status, ultimaPosicao
  const gpsEm = {}; // id do entregador -> quando chegou o último GPS (ms)
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
    // bubblingMouseEvents: o clique em cima de um marcador também chega ao mapa (senão não dá para escolher um destino perto dele)
    loja = L.marker([cfg.origem.lat, cfg.origem.lon], { bubblingMouseEvents: true }).addTo(mapa).bindTooltip(cfg.origem.nome, { permanent: true, direction: 'top', className: 'rotulo' });

    // abas da lateral: Pedidos | QR | Testes
    document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.aba').forEach((x) => x.classList.toggle('ativa', x === b));
      document.querySelectorAll('.painel-aba').forEach((p) => p.classList.toggle('ativa', p.id === 'aba-' + b.dataset.aba));
      if (b.dataset.aba === 'testes') abrirTestes();
      else fecharTestes(); // a aba Testes só consulta a tela de testes enquanto está aberta
    }));
    $('testes-restaurar').addEventListener('click', () => acionarTeste('restaurar'));

    // "Pedido pelo mapa": só com o formulário aberto o clique no mapa escolhe o destino
    $('abrir-criar').addEventListener('click', () => ligarModoCriar(!modoCriar));
    $('cancelar-criar').addEventListener('click', () => ligarModoCriar(false));
    mapa.on('click', (e) => {
      if (!modoCriar) return;
      destinoEscolhido = e.latlng;
      if (marcadorDestino) marcadorDestino.setLatLng(e.latlng);
      else marcadorDestino = L.marker(e.latlng, { opacity: 0.7, bubblingMouseEvents: true }).addTo(mapa);
      $('destino-info').textContent = textoDestino(e.latlng);
      $('criar-ok').textContent = '';
      $('criar').disabled = false;
    });
    $('criar').addEventListener('click', criarPedido);

    // modo telão: esconde as ferramentas e deixa só o que a turma precisa ver (mapa, pedidos e QR)
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
    setInterval(atualizarEntregadores, 4000); // quem ficou Disponível ou Offline
    setInterval(() => { atualizarBarra(); desenharEntregadores(); }, 1000);
  }

  // ---------------------------------------------------------------- pedido pelo mapa (ferramenta de apoio)
  const textoDestino = (ll) => 'Destino: ' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) + '. Clique em outro ponto para mudar.';

  function ligarModoCriar(ligado) {
    modoCriar = ligado;
    $('form-criar').classList.toggle('oculto', !ligado);
    $('mapa').classList.toggle('criando', ligado); // o cursor vira uma mira
    $('abrir-criar').textContent = ligado ? '✕ Fechar' : '＋ Pedido pelo mapa';
    $('criar-ok').textContent = '';
    $('criar-erro').textContent = '';
    if (!ligado) {
      if (marcadorDestino) { mapa.removeLayer(marcadorDestino); marcadorDestino = null; }
      destinoEscolhido = null;
      $('criar').disabled = true;
    }
    // toda vez que abre, a instrução volta (nada de ficar com o texto do pedido anterior)
    $('destino-info').textContent = destinoEscolhido ? textoDestino(destinoEscolhido) : '1. Clique no mapa onde o pedido deve chegar.';
  }

  async function criarPedido() {
    const erro = $('criar-erro');
    erro.textContent = '';
    $('criar-ok').textContent = '';
    if (!destinoEscolhido) return;
    $('criar').disabled = true;
    const corpo = { destino: { lat: destinoEscolhido.lat, lon: destinoEscolhido.lng }, promocao: $('tipo-pedido').value === 'promocao' };
    const pref = $('entregador').value;
    if (pref) corpo.entregadorPreferidoId = Number(pref);
    try {
      const r = await Auth.api('/api/pedidos', { method: 'POST', body: corpo });
      if (r.status !== 202) throw new Error('Não consegui criar o pedido (' + r.status + ').');
      const j = await r.json();
      // o formulário continua aberto com o mesmo destino: dá para criar outro igual ou clicar em outro ponto
      $('criar-ok').textContent = '✔ Pedido #' + j.id + ' criado. Crie outro igual ou clique em outro ponto do mapa.';
      atualizarLista();
      setTimeout(() => { if (destinoEscolhido) $('criar').disabled = false; }, 800); // evita o duplo clique sem querer
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

  // O que cada status quer dizer, em palavras de quem opera (e a cor do selo)
  function situacao(p) {
    switch (p.status) {
      case 'RECEBIDO': return ['Recebido', 'RECEBIDO'];
      case 'AGUARDANDO_PAGAMENTO': return ['Pagando', 'AGUARDANDO_PAGAMENTO'];
      case 'CONFIRMADO': return p.destino ? ['Aguardando entregador', 'AGUARDANDO_ENTREGADOR'] : ['Confirmado', 'CONFIRMADO'];
      case 'EM_ENTREGA': return ['Em entrega', 'EM_ENTREGA'];
      case 'ENTREGUE': return ['Entregue', 'ENTREGUE'];
      case 'ESGOTADO': return ['Esgotado', 'ESGOTADO'];
      case 'CANCELADO': return [p.motivo === 'PRAZO_EXPIRADO' ? 'Cancelado (demorou)' : 'Cancelado (pagamento)', 'CANCELADO'];
      case 'ESTORNADO': return ['Estornado', 'ESTORNADO'];
      default: return [p.status, p.status];
    }
  }

  function nomeDoEntregador(id) {
    if (!id) return '–';
    const e = listaEntregadores.find((x) => x.id === id);
    return e ? e.nome : '#' + id;
  }

  function renderPedidos(lista) {
    const tbody = $('pedidos');
    // telão: só o número e a situação de cada pedido, nunca o apelido de quem pediu
    tbody.innerHTML = lista.slice(0, 15).map((p) => {
      const [texto, classe] = situacao(p);
      // 🎟️ = o pedido usou o cupom da promoção (uma das unidades do estoque)
      const cupom = p.promocao === false ? '' : ' <span title="usou o cupom da promoção">🎟️</span>';
      return '<tr><td>#' + Auth.escapar(p.id) + cupom + '</td><td><span class="badge ' + Auth.escapar(classe) + '">' + Auth.escapar(texto) +
        '</span></td><td>' + Auth.escapar(nomeDoEntregador(p.entregadorId)) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="vazio">Nenhum pedido ainda.</td></tr>';

    // destinos dos pedidos que ainda têm entrega pela frente
    for (const p of lista) {
      const ativo = p.destino && (p.status === 'CONFIRMADO' || p.status === 'EM_ENTREGA');
      const rotulo = '#' + p.id + ' · ' + situacao(p)[0];
      if (ativo && !destinos[p.id]) {
        destinos[p.id] = L.circleMarker([p.destino.lat, p.destino.lon], { radius: 8, color: '#e8590c', fillOpacity: 0.3 })
          .addTo(mapa).bindTooltip(rotulo, { className: 'rotulo' });
      } else if (ativo) {
        destinos[p.id].setTooltipContent(rotulo);
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
    listaEntregadores = await r.json();
    const sel = $('entregador');
    const atual = sel.value;
    sel.innerHTML = '<option value="">Qualquer entregador</option>' +
      listaEntregadores.map((e) => '<option value="' + Auth.escapar(e.id) + '">' + Auth.escapar(e.nome) + '</option>').join('');
    sel.value = atual;
    listaEntregadores.forEach((e) => {
      if (!e.ultimaPosicao) return;
      gpsEm[e.id] = Math.max(gpsEm[e.id] || 0, e.ultimaPosicao.ts);
      moverEntregador(e.id, e.nome, e.ultimaPosicao.lat, e.ultimaPosicao.lon, null);
    });
    desenharEntregadores();
  }

  // Quem são os entregadores, em que situação estão e há quanto tempo o GPS de cada um chegou
  function desenharEntregadores() {
    const rotulos = { DISPONIVEL: 'Disponível', OCUPADO: 'Em entrega', OFFLINE: 'Offline' };
    $('entregadores-lista').innerHTML = listaEntregadores.map((e) => {
      const idade = gpsEm[e.id] ? Math.round((Date.now() - gpsEm[e.id]) / 1000) : null;
      const gps = idade === null ? 'sem GPS' : idade < 120 ? 'GPS há ' + idade + ' s' : 'GPS parado há ' + Math.round(idade / 60) + ' min';
      return '<li><span class="bolinha ' + Auth.escapar(e.status) + '"></span><b>' + Auth.escapar(e.nome) + '</b>' +
        '<span class="sit">' + Auth.escapar(rotulos[e.status] || e.status) + '</span><small>' + gps + '</small></li>';
    }).join('') || '<li class="vazio">Nenhum entregador cadastrado.</li>';
  }

  function moverEntregador(id, nome, lat, lon, pedidoId) {
    let e = entregadores[id];
    if (!e) {
      const icone = L.divIcon({ className: 'icone-entregador', html: '🛵', iconSize: [28, 28], iconAnchor: [14, 14] });
      e = entregadores[id] = { nome: nome || 'Entregador ' + id, marcador: L.marker([lat, lon], { icon: icone, zIndexOffset: 1000, bubblingMouseEvents: true }).addTo(mapa) };
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
        gpsEm[m.entregadorId] = Date.now();
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

  // ---------------------------------------------------------------- testes de falha do professor (aba Testes)
  // Os testes derrubam serviços de verdade, então rodam numa tela local do notebook (./demo.sh testes, que o ./demo.sh subir
  // já liga), que só atende páginas de localhost. Esta aba fala com ela; por isso só funciona com o painel aberto por localhost
  // (e nunca pelo link público, que a plateia também enxerga).
  const TESTES_URL = 'http://localhost:8099';
  const NO_NOTEBOOK = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  let testesPronto = false;
  let testesTimer = null;
  let testesVistas = 0; // quantas linhas da saída já estão na tela
  let testesId = null; // qual execução está na tela
  const testesNomes = {}; // id do teste -> nome, para o título da execução

  const testesChamar = (caminho, corpo) => fetch(TESTES_URL + caminho, corpo
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : undefined);

  function testesAviso(texto) {
    $('testes-aviso').textContent = texto || '';
    $('testes-aviso').classList.toggle('oculto', !texto);
  }

  async function abrirTestes() {
    if (!NO_NOTEBOOK) {
      return testesAviso('Os testes só funcionam com o painel aberto no notebook, por http://localhost:8080/painel/ (por segurança, nunca pelo link público).');
    }
    if (!testesPronto) {
      try {
        desenharTestes(await (await testesChamar('/api/cenarios')).json());
        testesPronto = true;
        testesAviso('');
      } catch (e) {
        return testesAviso('A tela de testes não está ligada. No terminal, rode ./demo.sh testes (o ./demo.sh subir já liga).');
      }
    }
    atualizarTestes();
    clearInterval(testesTimer);
    testesTimer = setInterval(atualizarTestes, 1000);
  }

  function fecharTestes() { clearInterval(testesTimer); }

  function desenharTestes(cenarios) {
    const lista = $('testes-lista');
    lista.textContent = '';
    const texto = (tag, conteudo, classe) => { const el = document.createElement(tag); el.textContent = conteudo; if (classe) el.className = classe; return el; };
    for (const c of cenarios) {
      testesNomes[c.id] = 'F' + c.id + ' · ' + c.nome;
      const cartao = document.createElement('div');
      cartao.className = 'teste';
      cartao.id = 'teste-' + c.id;
      const botao = texto('button', 'Acionar');
      botao.addEventListener('click', () => acionarTeste(c.id));
      const cab = document.createElement('div');
      cab.className = 'teste-cab';
      cab.append(texto('span', 'F' + c.id, 'teste-num'), texto('b', c.nome), botao);
      const det = document.createElement('details');
      const acontece = document.createElement('p');
      acontece.append(texto('b', 'O que acontece: '), c.acontece);
      const esperado = document.createElement('p');
      esperado.append(texto('b', 'Esperado: '), c.esperado);
      det.append(texto('summary', 'o que acontece e o esperado'), acontece, esperado);
      cartao.append(cab, texto('p', '“' + c.pede + '”', 'teste-pede'), det);
      lista.appendChild(cartao);
    }
  }

  async function acionarTeste(id) {
    try {
      const r = await testesChamar('/api/executar', { id });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return testesAviso(j.erro || 'Não consegui acionar o teste.');
      }
      testesAviso('');
      await atualizarTestes();
      $('testes-exec').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // a execução fica no topo da aba
    } catch (e) {
      testesAviso('A tela de testes não respondeu. Rode ./demo.sh testes no terminal.');
    }
  }

  function classeDaLinha(linha) {
    if (/^\s*\[OK\]/.test(linha)) return 't-ok';
    if (/^\s*\[ERRO\]/.test(linha)) return 't-erro';
    if (/^===/.test(linha)) return 't-titulo';
    if (/^\S+: PASSOU/.test(linha)) return 't-passou';
    if (/^\S+: FALHOU/.test(linha)) return 't-falhou';
    if (/^Mostre agora:/.test(linha)) return 't-dica';
    if (/^(Passo|Resultado|Histórico)/.test(linha)) return 't-passo';
    return '';
  }

  const mmss = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

  async function atualizarTestes() {
    let e;
    try { e = await (await testesChamar('/api/estado?desde=' + testesVistas)).json(); } catch (erro) { return; }
    const saida = $('testes-console');
    if (e.id !== testesId || e.total < testesVistas) { // outra execução (ou a tela de testes reiniciou): recomeça o quadro
      testesId = e.id;
      testesVistas = 0;
      saida.textContent = '';
      if (e.id) return atualizarTestes();
    }
    saida.classList.toggle('oculto', !e.id); // sem nenhuma execução ainda, não há saída para mostrar
    $('testes-titulo').textContent = !e.id ? 'Execução'
      : e.id === 'restaurar' ? 'Voltar ao normal' : e.id === 'todas' ? 'Todos os testes' : (testesNomes[e.id] || 'F' + e.id);
    const embaixo = saida.scrollTop + saida.clientHeight >= saida.scrollHeight - 30;
    for (const linha of e.linhas) {
      const el = document.createElement('div');
      el.className = classeDaLinha(linha);
      el.textContent = linha || ' ';
      saida.appendChild(el);
    }
    testesVistas = e.total;
    if (embaixo) saida.scrollTop = saida.scrollHeight;

    const estado = $('testes-estado');
    const faixa = $('testes-resultado');
    if (e.rodando) {
      estado.className = 'estado-teste rodando';
      estado.textContent = 'rodando ' + mmss(e.decorrido);
      faixa.classList.add('oculto');
    } else if (e.resultado) {
      estado.className = 'estado-teste ' + e.resultado;
      estado.textContent = (e.resultado === 'passou' ? 'passou' : 'falhou') + ' em ' + mmss(e.decorrido);
      faixa.className = 'testes-resultado ' + e.resultado;
      const nome = e.id === 'restaurar' ? 'Voltar ao normal' : e.id === 'todas' ? 'Todos os testes' : 'F' + e.id;
      $('testes-faixa').textContent = e.resultado === 'passou' ? '✅ ' + nome + ': PASSOU' : '❌ ' + nome + ': FALHOU (veja as linhas [ERRO])';
      $('testes-dica').textContent = e.dica ? 'Mostre agora: ' + e.dica : '';
    } else {
      estado.className = 'estado-teste';
      estado.textContent = 'parado';
      faixa.classList.add('oculto');
    }
    for (const b of document.querySelectorAll('#testes-lista button, #testes-restaurar')) b.disabled = e.rodando;
    for (const c of document.querySelectorAll('#testes-lista .teste')) c.classList.toggle('atual', e.id !== null && c.id === 'teste-' + e.id);
  }

  // ---------------------------------------------------------------- QR code
  // O QR leva para a página do cliente no endereço desta página. Aberto pelo link do túnel, o QR já sai certo e o campo
  // de endereço nem aparece. Aberto por localhost, o celular não alcança esse endereço: aí aparece o campo para colar
  // o link do túnel.
  async function configurarQr() {
    const r = await Auth.api('/api/auth/evento');
    if (!r.ok) return;
    const codigo = (await r.json()).codigo;
    const campo = $('url-publica');
    const local = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) || location.hostname.endsWith('.localhost');
    $('linha-url-publica').classList.toggle('oculto', !local);
    try {
      // um endereço guardado de um túnel antigo não vale mais: só é lido quando o painel está em localhost
      if (local) campo.value = localStorage.getItem('delivery.urlPublica') || '';
      else localStorage.removeItem('delivery.urlPublica');
    } catch (e) { /* sem storage */ }
    const desenhar = () => {
      const digitado = local ? campo.value.trim() : '';
      const base = (digitado || location.origin).replace(/\/+$/, '');
      const url = base + '/cliente/?codigo=' + encodeURIComponent(codigo);
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('qr').innerHTML = qr.createImgTag(6, 8);
      $('qr-link').textContent = url;
      $('link-entregador').textContent = base + '/entregador/';
      document.querySelector('.aviso-qr').classList.toggle('oculto', !local || !!digitado);
      try { if (local) localStorage.setItem('delivery.urlPublica', digitado); } catch (e) { /* sem storage */ }
    };
    campo.addEventListener('input', desenhar);
    desenhar();
  }
})();
