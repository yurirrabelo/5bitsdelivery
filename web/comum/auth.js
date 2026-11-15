// Sessão e chamadas autenticadas, compartilhadas pelas três telas.
// O token fica no localStorage; qualquer resposta 401 encerra a sessão.
(function () {
  const CHAVE = 'delivery.sessao';

  const Auth = {
    sessao() {
      try {
        return JSON.parse(localStorage.getItem(CHAVE));
      } catch (e) {
        return null;
      }
    },
    token() {
      const s = this.sessao();
      return s ? s.token : null;
    },
    usuario() {
      const s = this.sessao();
      return s ? s.usuario : null;
    },
    salvar(token, usuario) {
      localStorage.setItem(CHAVE, JSON.stringify({ token, usuario }));
    },
    sair() {
      localStorage.removeItem(CHAVE);
      location.reload();
    },

    // Operador ou entregador
    async login(username, password) {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) throw new Error(r.status === 429 ? 'Muitas tentativas. Espere um pouco.' : 'Usuário ou senha inválidos.');
      const j = await r.json();
      this.salvar(j.token, j.usuario);
      return j.usuario;
    },

    // Cliente do QR: apelido + código do evento
    async entrarComoCliente(apelido, codigo) {
      const r = await fetch('/api/auth/cliente', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apelido, codigo }),
      });
      if (!r.ok) throw new Error('Código do evento inválido ou apelido fora de 1 a 20 caracteres.');
      const j = await r.json();
      this.salvar(j.token, { id: null, nome: apelido, role: 'cliente', entregadorId: null });
      return this.usuario();
    },

    // fetch com o token; devolve a Response. 401 = sessão vencida.
    async api(url, opcoes) {
      const o = Object.assign({}, opcoes);
      o.headers = Object.assign({ Authorization: 'Bearer ' + this.token() }, o.headers);
      if (o.body && typeof o.body !== 'string') {
        o.body = JSON.stringify(o.body);
        o.headers['Content-Type'] = 'application/json';
      }
      const r = await fetch(url, o);
      if (r.status === 401) this.sair();
      return r;
    },

    // Monta o formulário de login dentro de um elemento. Cada tela dá o seu ícone, título e textos,
    // para a pessoa saber na hora onde está (cliente, entregador ou operador).
    montarLogin(el, papeisPermitidos, aoEntrar, opcoes) {
      const o = Object.assign({ icone: '🔐', titulo: 'Entrar', subtitulo: '', botao: 'Entrar', rotuloUsuario: 'Usuário' }, opcoes);
      el.innerHTML =
        '<div class="login-wrap">' +
        '<p class="login-marca marca"><img src="/comum/logo.svg" alt=""><span><span class="bits">5bits</span> Deliverty</span></p>' +
        '<form class="login">' +
        '<div class="login-icone">' + o.icone + '</div>' +
        '<h2>' + o.titulo + '</h2>' +
        (o.subtitulo ? '<p class="login-sub">' + o.subtitulo + '</p>' : '') +
        '<label>' + o.rotuloUsuario + ' <input name="u" autocomplete="username" autocapitalize="none" required></label>' +
        '<label>Senha <input name="p" type="password" autocomplete="current-password" required></label>' +
        '<button type="submit">' + o.botao + '</button>' +
        '<p class="erro" role="alert"></p>' +
        '</form></div>';
      const form = el.querySelector('form');
      const erro = el.querySelector('.erro');
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        erro.textContent = '';
        try {
          const u = await Auth.login(form.u.value.trim(), form.p.value);
          if (!papeisPermitidos.includes(u.role)) {
            localStorage.removeItem(CHAVE);
            throw new Error('Este usuário não tem acesso a esta tela.');
          }
          aoEntrar(u);
        } catch (e) {
          erro.textContent = e.message; // textContent: nunca interpreta HTML
        }
      });
    },

    // Escapa texto antes de usar em innerHTML
    escapar(t) {
      return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    },
  };

  window.Auth = Auth;
})();
