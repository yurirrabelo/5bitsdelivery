// App do entregador (PWA): status, entrega atual e envio opcional da localização.
(function () {
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- instalação (PWA)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/entregador/sw.js').catch(() => {});
  let promptInstalar = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    promptInstalar = e;
    $('instalar').hidden = false;
  });
  $('instalar').addEventListener('click', async () => {
    if (!promptInstalar) return;
    promptInstalar.prompt();
    promptInstalar = null;
    $('instalar').hidden = true;
  });

  // ---------------------------------------------------------------- login
  function mostrarApp(u) {
    $('login').classList.add('oculto');
    $('app').classList.remove('oculto');
    $('quem').textContent = u.nome;
    iniciar();
  }
  $('sair').addEventListener('click', () => Auth.sair());
  const u = Auth.usuario();
  if (u && u.role === 'entregador') mostrarApp(u);
  else Auth.montarLogin($('login'), ['entregador'], mostrarApp);

  // ---------------------------------------------------------------- status e entrega atual
  let atual = null;

  function iniciar() {
    atualizar();
    setInterval(atualizar, 5000); // polling a cada 5 s
    $('btn-disponivel').addEventListener('click', () => mudarStatus('DISPONIVEL'));
    $('btn-offline').addEventListener('click', () => mudarStatus('OFFLINE'));
    $('confirmar').addEventListener('click', confirmarEntrega);
    $('enviar-local').addEventListener('change', (e) => (e.target.checked ? ligarLocalizacao() : desligarLocalizacao()));
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
    const el = $('status-texto');
    el.textContent = { DISPONIVEL: 'Disponível', OCUPADO: 'Em entrega', OFFLINE: 'Offline' }[st] || st;
    el.className = 'status-atual ' + st;
    // OCUPADO só o sistema define
    $('btn-disponivel').disabled = st === 'OCUPADO' || st === 'DISPONIVEL';
    $('btn-offline').disabled = st === 'OCUPADO' || st === 'OFFLINE';

    const e = atual.entrega;
    $('sem-entrega').classList.toggle('oculto', !!e);
    $('com-entrega').classList.toggle('oculto', !e);
    if (e) {
      $('entrega-pedido').textContent = '#' + e.pedidoId;
      $('entrega-destino').textContent = e.destino.lat.toFixed(5) + ', ' + e.destino.lon.toFixed(5);
      $('entrega-distancia').textContent = e.distanciaM === null ? '–' : (e.distanciaM >= 1000 ? (e.distanciaM / 1000).toFixed(1) + ' km' : e.distanciaM + ' m');
      $('abrir-rota').href = e.linkMapas;
    }
  }

  async function mudarStatus(status) {
    $('status-erro').textContent = '';
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

  // ---------------------------------------------------------------- localização pelo app (opcional)
  // watchPosition -> POST /api/entregas/posicoes a cada ~3 s, com Wake Lock para a tela não apagar.
  let watchId = null, ultimoEnvio = 0, wakeLock = null;

  async function ligarLocalizacao() {
    if (!('geolocation' in navigator)) {
      $('local-info').textContent = 'Este aparelho não tem geolocalização.';
      $('enviar-local').checked = false;
      return;
    }
    watchId = navigator.geolocation.watchPosition(enviarPosicao, (err) => {
      $('local-info').textContent = 'Sem permissão de localização: ' + err.message;
      $('enviar-local').checked = false;
      desligarLocalizacao();
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* sem Wake Lock: segue sem */ }
    $('local-info').textContent = 'Enviando a localização a cada ~3 s. Mantenha o app aberto.';
  }

  function desligarLocalizacao() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    $('local-info').textContent = 'A fonte principal é o Traccar Client. Use uma fonte por vez. Este modo só funciona com o app aberto.';
  }

  function enviarPosicao(pos) {
    const agora = Date.now();
    if (agora - ultimoEnvio < 2800) return;
    ultimoEnvio = agora;
    // velocidade em m/s (padrão da Geolocation API); o servidor converte
    Auth.api('/api/entregas/posicoes', {
      method: 'POST',
      body: { lat: pos.coords.latitude, lon: pos.coords.longitude, precisao: pos.coords.accuracy, velocidade: pos.coords.speed, timestamp: pos.timestamp },
    }).catch(() => {});
  }
  document.addEventListener('visibilitychange', async () => {
    // o Wake Lock é solto quando a página fica em segundo plano: pede de novo ao voltar
    if (document.visibilityState === 'visible' && watchId !== null && 'wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignora */ }
    }
  });
})();
