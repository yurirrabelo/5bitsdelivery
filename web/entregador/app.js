// Página do entregador. O celular abre o link, entra e fica "Disponível": o navegador passa a enviar o GPS real
// (Geolocation API) a cada ~3 s, o pedido aparece aqui e a entrega termina sozinha ao chegar no destino.
// Não precisa instalar nada. O GPS só funciona em https:// (o túnel) ou em localhost.
(function () {
  const $ = (id) => document.getElementById(id);
  const INTERVALO_ENVIO_MS = 3000; // uma posição a cada 3 s
  const POSICAO_VELHA_MS = 20000; // sem fix novo por esse tempo: GPS sem sinal

  // versões antigas desta tela instalavam um service worker: remove para não servir arquivos velhos
  if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});

  // ---------------------------------------------------------------- login
  function mostrarApp(u) {
    $('login').classList.add('oculto');
    $('app').classList.remove('oculto');
    $('quem').textContent = u.nome;
    iniciar();
  }
  $('sair').addEventListener('click', () => { desligarGps(); Auth.sair(); });
  const u = Auth.usuario();
  if (u && u.role === 'entregador') mostrarApp(u);
  else {
    $('login').classList.remove('oculto');
    Auth.montarLogin($('login'), ['entregador'], mostrarApp, {
      icone: '🛵', titulo: 'Área do entregador', subtitulo: 'Entre para receber as entregas e enviar o seu GPS.',
      botao: 'Entrar e começar', rotuloUsuario: 'Seu usuário',
    });
  }

  // ---------------------------------------------------------------- status e entrega atual
  let atual = null; // última resposta de GET /api/entregas/me
  let pedidoVisto; // entrega que já mostramos (undefined = ainda não olhou)

  function iniciar() {
    $('btn-disponivel').addEventListener('click', () => { liberarSom(); mudarStatus('DISPONIVEL'); });
    $('btn-offline').addEventListener('click', () => mudarStatus('OFFLINE'));
    $('confirmar').addEventListener('click', confirmarEntrega);
    $('gps-tentar').addEventListener('click', () => ligarGps(true));
    atualizar();
    setInterval(atualizar, 3000);
    setInterval(enviarPosicao, INTERVALO_ENVIO_MS);
  }

  async function atualizar() {
    try {
      const r = await Auth.api('/api/entregas/me');
      if (!r.ok) return;
      atual = await r.json();
      renderizar();
    } catch (e) { /* sem rede: tenta no próximo ciclo */ }
  }

  function renderizar() {
    const st = atual.entregador.status;
    $('status-texto').textContent = { DISPONIVEL: 'Disponível', OCUPADO: 'Em entrega', OFFLINE: 'Offline' }[st] || st;
    $('estado').dataset.status = st; // a cor do cartão e do título vem daqui
    // OCUPADO só o sistema define
    $('btn-disponivel').disabled = st === 'OCUPADO' || st === 'DISPONIVEL';
    $('btn-offline').disabled = st === 'OCUPADO' || st === 'OFFLINE';

    // o GPS acompanha o status: ligado se Disponível ou em entrega, desligado se Offline
    if (st === 'OFFLINE') desligarGps();
    else ligarGps();

    const e = atual.entrega;
    $('app').classList.toggle('tem-entrega', !!e);
    $('sem-entrega').classList.toggle('oculto', !!e);
    $('com-entrega').classList.toggle('oculto', !e);
    if (e) {
      $('entrega-pedido').textContent = '#' + e.pedidoId;
      mostrarMapa(e);
      atualizarDistanciaEMapa();
    }

    // nova entrega (ou entrega que acabou) desde a última leitura
    const agora = e ? e.pedidoId : null;
    if (pedidoVisto !== undefined && agora !== pedidoVisto) {
      if (agora !== null) avisarNovaEntrega(agora);
      else mostrarFaixa('faixa-entregue', 8000);
    }
    pedidoVisto = agora;
  }

  async function mudarStatus(status) {
    $('status-erro').textContent = '';
    if (status === 'DISPONIVEL') ligarGps(true); // dentro do toque: o navegador pergunta a permissão na hora
    const r = await Auth.api('/api/entregas/me/status', { method: 'PATCH', body: { status } });
    if (!r.ok) $('status-erro').textContent = r.status === 409 ? 'Você está com uma entrega em andamento.' : 'Não consegui mudar o status.';
    atualizar();
  }

  async function confirmarEntrega() {
    if (!atual || !atual.entrega) return;
    if (!confirm('Confirmar que o pedido #' + atual.entrega.pedidoId + ' foi entregue?')) return;
    $('entrega-erro').textContent = '';
    const r = await Auth.api('/api/entregas/' + atual.entrega.pedidoId + '/confirmar', { method: 'POST' });
    if (!r.ok) $('entrega-erro').textContent = 'Não consegui confirmar (' + r.status + ').';
    atualizar();
  }

  // ---------------------------------------------------------------- aviso de nova entrega (tela, vibração e som)
  let audio = null;
  function liberarSom() { // o navegador só deixa tocar som depois de um toque do usuário
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  document.addEventListener('pointerdown', liberarSom, { once: true }); // o primeiro toque (até o do login) libera o som

  function bip(vezes) {
    if (!audio) return;
    for (let i = 0; i < vezes; i++) {
      const osc = audio.createOscillator();
      const ganho = audio.createGain();
      osc.frequency.value = 880;
      ganho.gain.value = 0.25;
      osc.connect(ganho).connect(audio.destination);
      osc.start(audio.currentTime + i * 0.4);
      osc.stop(audio.currentTime + i * 0.4 + 0.25);
    }
  }

  function avisarNovaEntrega(pedidoId) {
    $('faixa-numero').textContent = '#' + pedidoId;
    mostrarFaixa('faixa-nova', 12000);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
    bip(3);
  }

  const temporizadores = {};
  function mostrarFaixa(id, ms) {
    $(id).classList.remove('oculto');
    clearTimeout(temporizadores[id]);
    temporizadores[id] = setTimeout(() => $(id).classList.add('oculto'), ms);
  }

  // ---------------------------------------------------------------- GPS do navegador
  let watchId = null;
  let posicao = null; // último fix: { lat, lon, precisao, velocidade, quando }
  let wakeLock = null;
  let redeCaiu = false;
  let bloqueado = false; // o usuário negou a localização: só tenta de novo quando ele pedir

  function estadoGps(estado, titulo, detalhe) {
    $('gps').dataset.estado = estado; // desligado | procurando | ok | erro
    $('gps-titulo').textContent = titulo;
    $('gps-detalhe').textContent = detalhe;
    $('gps-tentar').classList.toggle('oculto', estado !== 'erro');
  }

  // porToque = true quando foi o usuário que pediu (Disponível ou "Tentar de novo")
  function ligarGps(porToque) {
    if (watchId !== null) return;
    if (bloqueado && !porToque) return;
    bloqueado = false;
    if (!('geolocation' in navigator)) {
      return estadoGps('erro', 'Este aparelho não tem GPS', 'Abra a página em um celular.');
    }
    if (!window.isSecureContext) {
      return estadoGps('erro', 'Abra o link https://', 'O navegador só libera o GPS em páginas https:// (use o link do túnel, não o IP da rede).');
    }
    estadoGps('procurando', 'Procurando sinal de GPS…', posicao ? 'Aguarde alguns segundos.' : 'Permita a localização quando o navegador perguntar.');
    watchId = navigator.geolocation.watchPosition(aoReceberPosicao, aoFalharGps, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    pedirTelaLigada();
  }

  function desligarGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    posicao = null;
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    estadoGps('desligado', 'GPS desligado', 'Toque em Disponível e permita a localização.');
  }

  function aoReceberPosicao(pos) {
    posicao = { lat: pos.coords.latitude, lon: pos.coords.longitude, precisao: pos.coords.accuracy, velocidade: pos.coords.speed, quando: Date.now() };
    mostrarEstadoGps();
    atualizarDistanciaEMapa();
  }

  function aoFalharGps(err) {
    if (err.code === 1) { // permissão negada: não adianta insistir
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      bloqueado = true;
      return estadoGps('erro', 'Localização bloqueada', 'No navegador, libere a localização para este site e toque em Disponível de novo.');
    }
    estadoGps('procurando', 'Sem sinal de GPS', 'Vá para um lugar aberto. Continuo procurando…');
  }

  function mostrarEstadoGps() {
    if (!posicao) return;
    const idade = Date.now() - posicao.quando;
    if (idade > POSICAO_VELHA_MS) return estadoGps('procurando', 'Sem sinal de GPS', 'Vá para um lugar aberto. Continuo procurando…');
    if (redeCaiu) return estadoGps('procurando', 'GPS ok, sem conexão com o sistema', 'Reenviando assim que a conexão voltar.');
    estadoGps('ok', 'GPS enviando', 'Precisão de ' + Math.round(posicao.precisao) + ' m. Mantenha a tela ligada.');
  }

  // A cada 3 s manda o último fix (mesmo parado: o painel precisa saber que você está vivo)
  async function enviarPosicao() {
    if (watchId === null || !posicao) return;
    mostrarEstadoGps();
    if (Date.now() - posicao.quando > POSICAO_VELHA_MS) return;
    try {
      const r = await Auth.api('/api/entregas/posicoes', {
        method: 'POST',
        body: { lat: posicao.lat, lon: posicao.lon, precisao: posicao.precisao, velocidade: posicao.velocidade }, // m/s, como a API do navegador
      });
      redeCaiu = !r.ok && r.status >= 500;
    } catch (e) {
      redeCaiu = true;
    }
  }

  // A tela não pode apagar: sem ela o navegador para o GPS. O sistema solta o bloqueio quando a página sai de cena.
  async function pedirTelaLigada() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* sem Wake Lock: o GPS funciona, mas a tela pode apagar */ }
  }
  // Ao voltar para a página (tela desbloqueada, outro app fechado) refaz a assinatura do GPS e a tela ligada:
  // alguns navegadores (iPhone) não retomam o GPS sozinhos depois de ficar em segundo plano.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || watchId === null) return;
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    ligarGps(true);
  });

  // ---------------------------------------------------------------- distância e mapa
  function distanciaM(lat1, lon1, lat2, lon2) {
    const rad = (g) => (g * Math.PI) / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  let mapa = null, marcadorDestino = null, marcadorEu = null, linha = null, pedidoDoMapa = null;

  function mostrarMapa(e) {
    if (!mapa) {
      mapa = L.map('mapa', { zoomControl: false, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    }
    if (pedidoDoMapa !== e.pedidoId) { // entrega nova: recomeça o desenho
      pedidoDoMapa = e.pedidoId;
      if (marcadorDestino) mapa.removeLayer(marcadorDestino);
      marcadorDestino = L.marker([e.destino.lat, e.destino.lon]).addTo(mapa).bindTooltip('Destino', { permanent: true, direction: 'top' });
      mapa.setView([e.destino.lat, e.destino.lon], 16);
    }
    mapa.invalidateSize(); // o mapa estava escondido até agora
  }

  function atualizarDistanciaEMapa() {
    const e = atual && atual.entrega;
    if (!e) return;
    if (!posicao) {
      $('entrega-distancia').textContent = '–';
      return;
    }
    const m = Math.round(distanciaM(posicao.lat, posicao.lon, e.destino.lat, e.destino.lon));
    $('entrega-distancia').textContent = m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
    if (!mapa) return;
    const eu = [posicao.lat, posicao.lon];
    const alvo = [e.destino.lat, e.destino.lon];
    if (marcadorEu) marcadorEu.setLatLng(eu);
    else marcadorEu = L.circleMarker(eu, { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(mapa);
    if (linha) linha.setLatLngs([eu, alvo]);
    else linha = L.polyline([eu, alvo], { color: '#fbbf24', weight: 3, dashArray: '6 8' }).addTo(mapa);
    mapa.fitBounds([eu, alvo], { paddingTopLeft: [30, 55], paddingBottomRight: [30, 30], maxZoom: 17, animate: false }); // folga em cima para o rótulo "Destino"
  }
})();
