// Tela de testes de falha. Fala só com o servidor local (servidor.py): a lista de cenários (cenarios.json), o andamento do
// teste que está rodando (a saída do ./demo.sh falha N, linha por linha) e o estado dos bancos.
// Todo texto entra na tela por textContent.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const criar = (tag, classe, texto) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined && texto !== null) e.textContent = texto;
    return e;
  };
  const LINK_GRAFANA = 'http://localhost:3000/d/apresentacao/apresentacao';
  const LINK_DETALHES = 'http://localhost:3000/d/delivery-ao-vivo/detalhes-tecnicos';

  // Passos que todo cenário tem: o primeiro e o último são feitos pelos próprios scripts
  const PASSO_ZERAR = {
    icone: '🧹', titulo: 'Zerar o banco para começar do zero',
    porque: 'Cada teste parte de um banco limpo: sem pedidos de testes anteriores, estoque de volta às 10 unidades, entregadores livres e sem posição de GPS. Assim o resultado é fácil de ler e nada se confunde.',
  };
  const PASSO_VOLTAR = {
    icone: '↩️', titulo: 'Devolver o sistema ao normal',
    porque: 'Cada teste desfaz o que provocou (gateway normal, serviços no ar). É a prova de que o sistema volta ao normal e de que o próximo teste começa limpo.',
  };

  let catalogo = [];
  let atual = null; // o cenário que está na tela
  let exec = { id: null, rodando: false, resultado: null, dica: '', decorrido: 0, total: 0 };
  let linhas = []; // a saída do teste que está na tela
  let vistas = 0; // quantas linhas já chegaram do servidor
  const sessao = {}; // cenário -> como terminou nesta página ('passou' ou 'falhou')
  let avisoErro = '';
  let assinaturaVeredito = '';
  const ultimosBancos = {};

  // ---------------------------------------------------------------- o que a saída do script quer dizer
  const RE_CONFERENCIA = /^\s*\[(OK|ERRO)\]\s+(.*?)\s+esperado=(\S*)\s+obtido=(.*)$/;

  function interpretar(saida) {
    const m = { passo: -1, notas: {}, resultado: false, restaurando: false, conferencias: [], evidencias: [], caminho: [], veredito: null, dica: '' };
    let modo = 'passos';
    for (const l of saida) {
      let x;
      if ((x = /^Passo (\d+):/.exec(l))) {
        m.passo = Number(x[1]);
        modo = 'passos';
        if (m.resultado) m.passoTardio = m.passo; // o F3 confere a métrica depois de imprimir o "Resultado:"
        continue;
      }
      if (/^Resultado:/.test(l)) { m.resultado = true; modo = 'resultado'; continue; }
      if (/^Restaurando a configuração normal/.test(l)) { m.restaurando = true; modo = 'restaurando'; continue; }
      if ((x = RE_CONFERENCIA.exec(l))) { m.conferencias.push({ ok: x[1] === 'OK', o: x[2].trim(), esperado: x[3], obtido: x[4].trim() }); continue; }
      if (/^\s*\[ERRO\]/.test(l)) { m.conferencias.push({ ok: false, o: l.replace(/^\s*\[ERRO\]\s*/, ''), esperado: '', obtido: '' }); continue; }
      if ((x = /^(\S+): (PASSOU|FALHOU)/.exec(l))) { m.veredito = x[2] === 'PASSOU' ? 'passou' : 'falhou'; continue; }
      if (/^Mostre agora:/.test(l)) { m.dica = l.slice('Mostre agora:'.length).trim(); continue; }
      if (/^Histórico do pedido/.test(l)) { modo = 'historico'; continue; }
      if (modo === 'historico' && (x = /^\s*->\s*(\S+)/.exec(l))) { m.caminho.push(x[1].replace(/"/g, '')); continue; }
      if (/^===/.test(l) || !l.trim()) continue;
      if (modo === 'passos' && m.passo >= 0) (m.notas[m.passo] = m.notas[m.passo] || []).push(l.trim());
      else if (modo === 'restaurando') (m.notas.fim = m.notas.fim || []).push(l.trim());
      else if (modo === 'resultado' || modo === 'historico') m.evidencias.push(l.trim());
    }
    return m;
  }

  // Situação de cada passo: 0 = zerar o banco, 1..n = os passos do cenário, n+1 = devolver ao normal
  function situacaoDosPassos(c, m) {
    const n = c.passos.length;
    const s = new Array(n + 2).fill('pendente');
    if (!m) return s;
    const rodando = exec.rodando;
    if (m.passo >= 0) {
      for (let i = 0; i < Math.min(m.passo, n + 1); i++) s[i] = 'feito';
      if (m.passo <= n) s[m.passo] = rodando && !m.resultado && !m.restaurando ? 'rodando' : 'feito';
    }
    if (m.resultado) {
      for (let i = 0; i <= n; i++) s[i] = 'feito';
      if (m.passoTardio !== undefined && m.passoTardio <= n && rodando && !m.restaurando) s[m.passoTardio] = 'rodando';
    }
    if (m.restaurando) {
      for (let i = 0; i <= n; i++) if (s[i] !== 'erro') s[i] = 'feito';
      s[n + 1] = rodando ? 'rodando' : 'feito';
    }
    // o script parou no meio (antes de "Resultado:"): o passo em que parou fica em vermelho
    if (!rodando && exec.resultado === 'falhou' && !m.resultado && m.passo >= 0 && m.passo <= n) s[m.passo] = 'erro';
    return s;
  }

  const tempo = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const nomeDoTeste = (id) => (id === 'restaurar' ? 'Voltar ao normal' : id === 'todas' ? 'Ensaio completo' : 'F' + id);

  // ---------------------------------------------------------------- escolha do cenário (esquerda)
  function montarTrilho() {
    const lista = $('trilho');
    lista.textContent = '';
    for (const c of catalogo) {
      const b = criar('button', 'cena');
      b.type = 'button';
      b.id = 'cena-' + c.id;
      const txt = criar('span', 'cena-txt');
      txt.append(criar('b', null, c.nome), criar('small', null, c.professor.provocar));
      b.append(criar('span', 'cena-num', c.rotulo), txt, criar('span', 'cena-estado'));
      b.addEventListener('click', () => selecionar(c.id));
      lista.appendChild(b);
    }
  }

  function atualizarTrilho() {
    for (const c of catalogo) {
      const b = $('cena-' + c.id);
      b.classList.toggle('ativa', atual !== null && atual.id === c.id);
      const rodandoEste = exec.rodando && exec.id === c.id;
      b.querySelector('.cena-estado').textContent = rodandoEste ? '⏳' : sessao[c.id] === 'passou' ? '✅' : sessao[c.id] === 'falhou' ? '❌' : '';
    }
    $('rodar-todas').classList.toggle('ativa', atual !== null && atual.id === 'todas');
  }

  function selecionar(id) {
    atual = id === 'todas' ? { id: 'todas' } : catalogo.find((c) => c.id === id) || catalogo[0];
    try { history.replaceState(null, '', '#' + atual.id); } catch (e) { /* sem histórico */ }
    avisoErro = '';
    assinaturaVeredito = '';
    montarRoteiro();
    atualizarTela();
  }

  // ---------------------------------------------------------------- o roteiro do cenário (centro)
  function secao(classe, icone, cor, titulo, subtitulo) {
    const s = criar('section', 'cartao ' + classe);
    const h = criar('h2');
    h.append(criar('span', 'badge ' + cor, icone), document.createTextNode(titulo));
    if (subtitulo) h.append(criar('small', null, subtitulo));
    s.appendChild(h);
    return s;
  }

  // O botão grande da cabeça: o texto de cima muda ("Rodando…") e o de baixo diz quanto tempo o teste leva
  function botaoPrimario(texto, duracao, aoClicar) {
    const b = criar('button', 'primario');
    b.id = 'provocar';
    b.type = 'button';
    b.append(criar('span', 'rotulo-botao', texto), criar('small', null, duracao));
    b.addEventListener('click', aoClicar);
    return b;
  }

  function montarRoteiro() {
    const raiz = $('roteiro');
    raiz.textContent = '';
    if (atual.id === 'todas') return montarTodas(raiz);
    const c = atual;

    // cabeça (fica no alto ao rolar): quem é o cenário e o botão que provoca a falha
    const cabeca = criar('section', 'cabeca');
    const titulo = criar('div', 'cabeca-titulo');
    const nome = criar('div');
    const tags = criar('div', 'tags');
    c.tags.forEach((t) => tags.appendChild(criar('span', 'tag', t)));
    nome.append(criar('p', 'rotulo-cena', 'Cenário ' + c.rotulo), criar('h1', null, c.nome), tags);
    titulo.append(criar('span', 'selo', c.icone), nome);
    const acoes = criar('div', 'acoes');
    acoes.appendChild(botaoPrimario('▶ Provocar a falha', 'leva ' + c.tempo, provocar));
    cabeca.append(titulo, acoes);
    raiz.appendChild(cabeca);

    const aviso = criar('div', 'aviso-outro');
    aviso.id = 'aviso';
    aviso.hidden = true;
    raiz.appendChild(aviso);

    const veredito = criar('section', 'cartao veredito');
    veredito.id = 'veredito';
    veredito.hidden = true;
    raiz.appendChild(veredito);

    // 1. o que o professor pede
    const prof = secao('professor', '🎓', 'b-roxo', 'O professor pede');
    const q = criar('blockquote', 'provocar', '“' + c.professor.provocar + '”');
    prof.appendChild(q);
    if (c.professor.variante) prof.appendChild(criar('p', 'variante', c.professor.variante));
    const perg = criar('p', 'pergunta');
    perg.append(criar('b', null, 'Em outras palavras: '), document.createTextNode(c.pergunta));
    prof.appendChild(perg);
    prof.appendChild(criar('p', 'resumo', c.resumo));
    raiz.appendChild(prof);

    // 2. passo a passo, com o porquê de cada um
    const passos = secao('passos', '🧭', 'b-azul', 'Passo a passo', 'o que vamos fazer e por quê');
    const ol = criar('ol', 'linha-passos');
    ol.id = 'passos';
    const todos = [{ ...PASSO_ZERAR, generico: true }, ...c.passos, { ...PASSO_VOLTAR, generico: true }];
    todos.forEach((p, i) => {
      const li = criar('li', 'passo pendente' + (p.generico ? ' generico' : ''));
      li.id = 'passo-' + i;
      const corpo = criar('div', 'passo-corpo');
      const h = criar('h3');
      h.append(criar('span', 'ic', p.icone), document.createTextNode(p.titulo));
      const por = criar('p', 'porque');
      por.append(criar('b', null, '💡 Por quê: '), document.createTextNode(p.porque));
      const notas = criar('ul', 'notas');
      notas.id = 'notas-' + i;
      corpo.append(h, por, notas);
      li.append(criar('span', 'marca-passo', String(i + 1)), corpo);
      ol.appendChild(li);
    });
    passos.appendChild(ol);
    raiz.appendChild(passos);

    // 3. o resultado esperado (diga antes de provocar)
    const esp = secao('esperado', '🔮', 'b-verde', 'Resultado esperado', 'diga em voz alta antes de provocar');
    const ep = criar('p', 'esperado-prof');
    ep.append(criar('small', null, 'Resultado esperado pelo professor'), document.createTextNode(c.professor.esperado));
    esp.appendChild(ep);
    const ul = criar('ul', 'previsao');
    c.previsao.forEach((t) => ul.appendChild(criar('li', null, t)));
    esp.appendChild(ul);
    raiz.appendChild(esp);

    // 4. agora faça um pedido: o que o cliente vê
    const ped = secao('pedido', '🛒', 'b-laranja', c.pedido.acao, 'o que o cliente vê');
    const cel = criar('div', 'celular');
    cel.appendChild(criar('p', 'celular-topo', '📱 Tela do cliente'));
    const conversa = criar('div', 'conversa');
    conversa.appendChild(criar('div', 'bolha', c.pedido.cliente));
    c.pedido.respostas.forEach((r) => {
      const resp = criar('div', 'resposta ' + r.tom);
      if (r.quem) resp.appendChild(criar('span', 'quem', r.quem));
      const texto = criar('div');
      texto.append(criar('b', null, r.titulo), criar('p', null, r.detalhe));
      resp.append(criar('span', 'ic', r.icone), texto);
      conversa.appendChild(resp);
    });
    cel.appendChild(conversa);
    ped.appendChild(cel);
    const conf = criar('p', 'confirmacao', '⏳ Ainda não foi testado.');
    conf.id = 'confirmacao';
    ped.appendChild(conf);
    raiz.appendChild(ped);
  }

  // "Ensaio completo": todos os cenários em sequência, só para ensaiar
  function montarTodas(raiz) {
    const cabeca = criar('section', 'cabeca');
    const titulo = criar('div', 'cabeca-titulo');
    const nome = criar('div');
    nome.append(criar('p', 'rotulo-cena', 'Só para ensaiar'), criar('h1', null, 'Ensaio completo'));
    titulo.append(criar('span', 'selo', '🧪'), nome);
    const acoes = criar('div', 'acoes');
    acoes.appendChild(botaoPrimario('▶ Rodar todos', 'leva uns 14 min', rodarTodas));
    cabeca.append(titulo, acoes);
    raiz.appendChild(cabeca);
    const aviso = criar('div', 'aviso-outro');
    aviso.id = 'aviso';
    aviso.hidden = true;
    raiz.appendChild(aviso);
    const info = secao('professor', '🧪', 'b-roxo', 'Todos os cenários, um depois do outro');
    info.append(
      criar('p', null, 'Roda F1, F2, F3, F4, F5, F6, F6b, F7 e F8 em sequência, cada um com o banco zerado antes e o sistema devolvido ao normal depois. Serve para ensaiar antes da apresentação e ver se está tudo verde. No dia, o professor escolhe um só.'),
      criar('p', 'dica', 'Durante o ensaio o sistema falha de propósito várias vezes: não use o painel nem o celular ao mesmo tempo.'),
    );
    raiz.appendChild(info);
    const resumo = secao('esperado', '📋', 'b-verde', 'Resumo');
    const lista = criar('ul', 'previsao');
    lista.id = 'resumo-todas';
    resumo.appendChild(lista);
    raiz.appendChild(resumo);
  }

  // ---------------------------------------------------------------- atualização a cada segundo
  function atualizarTela() {
    if (!atual) return; // ainda não escolheu o cenário
    atualizarTrilho();
    const rodando = exec.rodando;
    const ehAtual = atual && exec.id === atual.id;
    const modelo = ehAtual && atual.id !== 'todas' ? interpretar(linhas) : null;

    const botao = $('provocar');
    if (botao) {
      botao.disabled = rodando;
      botao.querySelector('.rotulo-botao').textContent = rodando && ehAtual ? '⏳ Rodando…' : atual.id === 'todas' ? '▶ Rodar todos' : '▶ Provocar a falha';
      botao.title = rodando ? 'Espere o teste atual terminar' : '';
    }
    $('restaurar').disabled = rodando;
    $('rodar-todas').disabled = rodando;

    const aviso = $('aviso');
    if (aviso) {
      aviso.textContent = '';
      let texto = avisoErro;
      if (!texto && rodando && !ehAtual) texto = exec.id === 'restaurar' ? '↺ Voltando ao normal…' : '⏳ Está rodando outro teste: ' + nomeDoTeste(exec.id) + '. ';
      aviso.append(document.createTextNode(texto));
      if (!avisoErro && rodando && !ehAtual && exec.id !== 'restaurar') {
        const ver = criar('button', null, 'Ver ' + nomeDoTeste(exec.id));
        ver.type = 'button';
        ver.addEventListener('click', () => selecionar(exec.id));
        aviso.appendChild(ver);
      }
      aviso.hidden = !texto;
    }

    if (atual.id === 'todas') atualizarTodas(ehAtual);
    else atualizarPassos(modelo);
    atualizarVeredito(modelo, ehAtual);
    atualizarAoVivo(modelo);
  }

  function atualizarPassos(modelo) {
    const c = atual;
    const sit = situacaoDosPassos(c, modelo);
    sit.forEach((s, i) => {
      const li = $('passo-' + i);
      if (!li) return;
      li.className = 'passo ' + s + (i === 0 || i === sit.length - 1 ? ' generico' : '');
      const marca = li.querySelector('.marca-passo');
      marca.textContent = s === 'feito' ? '✓' : s === 'erro' ? '✕' : String(i + 1);
      const notas = $('notas-' + i);
      const lista = modelo ? (modelo.notas[i === sit.length - 1 ? 'fim' : i] || []).slice(-3) : [];
      const chave = lista.join('\n');
      if (notas.dataset.chave !== chave) {
        notas.dataset.chave = chave;
        notas.textContent = '';
        lista.forEach((t) => notas.appendChild(criar('li', null, t)));
      }
    });
    const conf = $('confirmacao');
    if (conf) {
      if (!modelo || exec.rodando) { conf.textContent = exec.rodando && modelo ? '⏳ O teste está rodando…' : '⏳ Ainda não foi testado.'; conf.className = 'confirmacao'; }
      else if (exec.resultado === 'passou') { conf.textContent = '✔ Confirmado pelo teste: foi exatamente isso que aconteceu.'; conf.className = 'confirmacao ok'; }
      else { conf.textContent = '✘ Diferente do esperado: veja o resultado no alto da página.'; conf.className = 'confirmacao ruim'; }
    }
  }

  function atualizarVeredito(modelo, ehAtual) {
    const caixa = $('veredito');
    if (!caixa) return;
    const pronto = ehAtual && !exec.rodando && exec.resultado && atual.id !== 'todas' && modelo;
    if (!pronto) { caixa.hidden = true; assinaturaVeredito = ''; return; }
    const assinatura = exec.id + '|' + exec.total + '|' + exec.resultado + '|' + (exec.foto ? exec.foto.atualizadoEm : '');
    if (assinatura === assinaturaVeredito) return;
    assinaturaVeredito = assinatura;

    const ok = exec.resultado === 'passou';
    caixa.hidden = false;
    caixa.className = 'cartao veredito ' + exec.resultado;
    caixa.textContent = '';
    const topo = criar('div', 'veredito-topo');
    topo.append(criar('h2', null, ok ? '✅ ' + atual.rotulo + ' passou' : '❌ ' + atual.rotulo + ' falhou'), criar('span', 'gasto', '⏱ ' + tempo(exec.decorrido)));
    caixa.appendChild(topo);
    const erros = modelo.conferencias.filter((x) => !x.ok).length;
    caixa.appendChild(criar('p', null, ok
      ? 'Tudo como previsto: cada conferência abaixo bate com o resultado esperado.'
      : 'Algo saiu diferente do esperado' + (erros ? ' (' + erros + ' conferência' + (erros > 1 ? 's' : '') + ' em vermelho)' : '') + '. Veja os logs ao lado.'));

    if (modelo.conferencias.length) {
      const tabela = criar('div', 'tabela');
      const cab = criar('div', 'cab');
      ['', 'O que conferimos', 'Esperado', 'Obtido'].forEach((t) => cab.appendChild(criar('span', null, t)));
      tabela.appendChild(cab);
      modelo.conferencias.forEach((x) => {
        const lin = criar('div', 'lin' + (x.ok ? '' : ' ruim'));
        lin.append(criar('span', null, x.ok ? '✔' : '✘'), criar('span', null, x.o), criar('span', 'valor', x.esperado), criar('span', 'valor obtido', x.obtido));
        tabela.appendChild(lin);
      });
      caixa.appendChild(tabela);
    }
    if (modelo.caminho.length) {
      const caminho = criar('div', 'caminho');
      caminho.appendChild(criar('span', 'rotulo', 'Caminho do pedido:'));
      modelo.caminho.forEach((st, i) => {
        if (i) caminho.appendChild(document.createTextNode('→'));
        caminho.appendChild(criar('span', 'status-chip ' + classeDoStatus(st), st));
      });
      caixa.appendChild(caminho);
    }
    if (exec.foto && exec.foto.bancos) { // o que o teste deixou nos bancos, antes de o script devolver o estoque ao normal
      const f = criar('div', 'foto-bancos');
      f.appendChild(criar('p', 'foto-titulo', '🗄️ Estado dos bancos ao fim do teste (às ' + exec.foto.atualizadoEm + ')'));
      const grade = criar('div', 'foto-grade');
      const b = exec.foto.bancos;
      grade.append(cartaoBanco('📦 Estoque', 'Estoque', b.estoque, false), cartaoBanco('🧾 Pedidos', 'Pedidos', b.pedidos, false), cartaoBanco('💳 Pagamentos', 'Pagamento', b.pagamento, false));
      f.appendChild(grade);
      f.appendChild(criar('p', 'dica', 'Ao terminar, o teste devolve o estoque ao normal: por isso a coluna ao vivo pode mostrar outro número.'));
      caixa.appendChild(f);
    }
    if (modelo.evidencias.length) {
      caixa.appendChild(criar('pre', 'evidencias', modelo.evidencias.join('\n')));
    }
    const dica = modelo.dica || exec.dica;
    if (ok && dica) {
      const m = criar('div', 'mostre');
      m.append(criar('b', null, '📺 Mostre agora'), document.createTextNode(dica));
      const botoes = criar('div', 'botoes');
      [['Abrir o Grafana: Apresentação', LINK_GRAFANA, false], ['Detalhes técnicos', LINK_DETALHES, true]].forEach(([t, href, sec]) => {
        const a = criar('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        const b = criar('button', sec ? 'secundario' : null, t);
        b.type = 'button';
        a.appendChild(b);
        botoes.appendChild(a);
      });
      m.appendChild(botoes);
      caixa.appendChild(m);
    }
    caixa.scrollIntoView({ behavior: 'smooth', block: 'start' }); // o resultado aparece à vista, logo abaixo da cabeça
  }

  function classeDoStatus(st) {
    if (/^(CONFIRMADO|ENTREGUE|APROVADO)$/.test(st)) return 'bom';
    if (/^(CANCELADO|ESGOTADO|ESTORNADO|RECUSADO)$/.test(st)) return 'mau';
    if (/^(RECEBIDO|AGUARDANDO_PAGAMENTO|AGUARDANDO_ENTREGADOR|EM_ENTREGA)$/.test(st)) return 'meio';
    return '';
  }

  function atualizarTodas(ehAtual) {
    const lista = $('resumo-todas');
    if (!lista) return;
    lista.textContent = '';
    if (!ehAtual) { lista.appendChild(criar('li', null, 'Ainda não rodou nesta página.')); return; }
    for (const l of linhas) {
      const x = /^\s+(PASSOU|FALHOU)\s+(\S+)$/.exec(l);
      if (x) lista.appendChild(criar('li', null, (x[1] === 'PASSOU' ? '✅ ' : '❌ ') + x[2]));
    }
    if (!lista.children.length) {
      const andamento = [...linhas].reverse().map((l) => /^# (\S+)$/.exec(l)).find(Boolean);
      lista.appendChild(criar('li', null, exec.rodando ? '⏳ Rodando' + (andamento ? ': ' + andamento[1] : '…') : 'Sem resultado.'));
    }
  }

  // ---------------------------------------------------------------- a coluna ao vivo
  function atualizarAoVivo(modelo) {
    const estado = $('estado');
    const rodando = exec.rodando;
    estado.className = 'estado' + (rodando ? ' rodando' : exec.resultado ? ' ' + exec.resultado : '');
    estado.textContent = rodando ? 'rodando' : exec.resultado === 'passou' ? 'passou' : exec.resultado === 'falhou' ? 'falhou' : 'parado';
    $('relogio').textContent = tempo(exec.decorrido || 0);

    // andamento e o que está acontecendo agora
    const c = catalogo.find((x) => x.id === exec.id);
    let frase = atual && atual.id !== 'todas' ? 'Pronto para provocar: ' + atual.nome + '. Leia o resultado esperado em voz alta e aperte o botão.' : 'Escolha um cenário e aperte “Provocar a falha”.';
    let pct = 0;
    if (exec.id === 'restaurar') {
      frase = rodando ? 'Devolvendo o sistema ao normal…' : exec.resultado === 'passou' ? '✔ Tudo de volta ao normal.' : '✘ Não consegui devolver tudo ao normal.';
      pct = rodando ? 50 : 100;
    } else if (exec.id === 'todas') {
      frase = rodando ? 'Ensaio completo em andamento…' : exec.resultado === 'passou' ? '✔ Todos os cenários passaram.' : exec.resultado ? '✘ Algum cenário falhou: veja o resumo.' : frase;
      pct = rodando ? 50 : exec.resultado ? 100 : 0;
    } else if (c) {
      const m = (atual && atual.id === c.id ? modelo : null) || interpretar(linhas);
      const sit = situacaoDosPassos(c, m);
      const feitos = sit.filter((s) => s === 'feito').length;
      pct = Math.round((feitos / sit.length) * 100);
      const todos = [PASSO_ZERAR, ...c.passos, PASSO_VOLTAR];
      const i = sit.indexOf('rodando');
      if (rodando) frase = i >= 0 ? 'Agora: ' + todos[i].icone + ' ' + todos[i].titulo : m.resultado ? 'Conferindo o resultado…' : 'Preparando…';
      else if (exec.resultado) frase = exec.resultado === 'passou' ? '✔ ' + c.rotulo + ' passou: o sistema se comportou como previsto.' : '✘ ' + c.rotulo + ' falhou: veja o resultado e os logs.';
    }
    $('passo-agora').textContent = frase;
    $('progresso').style.width = pct + '%';

    const s = $('situacao');
    s.className = 'situacao ' + (rodando ? 'rodando' : exec.resultado ? exec.resultado : 'pronto');
    s.querySelector('span').textContent = rodando ? 'teste em andamento: ' + nomeDoTeste(exec.id)
      : exec.resultado ? 'último teste: ' + nomeDoTeste(exec.id) + (exec.resultado === 'passou' ? ' passou' : ' falhou') : 'pronto';
  }

  function classeDaLinha(l) {
    if (/^\s*\[OK\]/.test(l)) return 'ok';
    if (/^\s*\[ERRO\]/.test(l)) return 'erro';
    if (/^===/.test(l)) return 'titulo';
    if (/^\S+: PASSOU/.test(l)) return 'passou';
    if (/^\S+: FALHOU/.test(l)) return 'falhou';
    if (/^Mostre agora:/.test(l)) return 'dica';
    if (/^(Passo|Resultado|Histórico)/.test(l)) return 'passo';
    return '';
  }

  // ---------------------------------------------------------------- conversa com o servidor
  async function sondar() {
    let e;
    try {
      e = await (await fetch('/api/estado?desde=' + vistas)).json();
    } catch (erro) {
      const s = $('situacao');
      s.className = 'situacao falhou';
      s.querySelector('span').textContent = 'a tela de testes parou (rode ./demo.sh testes)';
      return;
    }
    const saida = $('console');
    if (e.id !== exec.id || e.total < vistas) { // outra execução (ou o servidor reiniciou): recomeça do primeiro
      const novo = e.id !== null && e.id !== exec.id;
      exec = { ...exec, id: e.id };
      linhas = [];
      vistas = 0;
      saida.textContent = '';
      if (novo && e.rodando) {
        const nova = e.id === 'todas' ? 'todas' : catalogo.some((c) => c.id === e.id) ? e.id : null;
        if (nova && (!atual || atual.id !== nova)) selecionar(nova); // outra pessoa acionou: a tela mostra o que está rodando
      }
      if (e.id) return sondar();
      saida.innerHTML = '<span class="vazio">A saída do teste aparece aqui, ao vivo.</span>';
    }
    const embaixo = saida.scrollTop + saida.clientHeight >= saida.scrollHeight - 40;
    for (const l of e.linhas) {
      linhas.push(l);
      const d = criar('div', classeDaLinha(l), l || ' ');
      saida.appendChild(d);
    }
    while (saida.children.length > 1500) saida.removeChild(saida.firstChild);
    vistas = e.total;
    if (embaixo) saida.scrollTop = saida.scrollHeight;
    $('logs-contagem').textContent = linhas.length ? linhas.length + ' linhas' : '';

    exec = { id: e.id, rodando: e.rodando, resultado: e.resultado, dica: e.dica, decorrido: e.decorrido, total: e.total, foto: e.foto || null };
    if (!e.rodando && e.resultado && e.id && e.id !== 'restaurar') sessao[e.id] = e.resultado;
    atualizarTela();
  }

  async function postar(id) {
    avisoErro = '';
    try {
      const r = await fetch('/api/executar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        avisoErro = j.erro || 'Não consegui acionar o teste.';
        atualizarTela();
        return false;
      }
    } catch (e) {
      avisoErro = 'A tela de testes não respondeu. Rode ./demo.sh testes no terminal.';
      atualizarTela();
      return false;
    }
    await sondar();
    return true;
  }

  const provocar = () => postar(atual.id);
  const rodarTodas = () => { if (confirm('Rodar todos os cenários em sequência? Leva uns 14 minutos e o sistema vai falhar de propósito várias vezes.')) postar('todas'); };

  // ---------------------------------------------------------------- estado dos bancos
  function numero(chave, valor, rotulo, animar) {
    const n = criar('div', 'num');
    n.append(criar('b', null, String(valor)), criar('span', null, rotulo));
    if (animar) { // só a coluna ao vivo pisca quando o número muda
      if (chave in ultimosBancos && ultimosBancos[chave] !== valor) n.classList.add('mudou');
      ultimosBancos[chave] = valor;
    }
    return n;
  }

  function cartaoBanco(titulo, servico, d, animar = true) {
    const c = criar('div', 'banco');
    const nome = criar('div', 'banco-nome');
    nome.append(criar('span', null, titulo), criar('small', null, 'banco do ' + servico));
    c.appendChild(nome);
    if (!d) { c.appendChild(criar('p', 'sem-resposta', 'sem resposta agora')); return c; }
    const nums = criar('div', 'nums');
    if (servico === 'Estoque') {
      nums.append(numero('e.d', d.disponivel, 'disponíveis', animar), numero('e.r', d.reservado, 'reservadas', animar), numero('e.v', d.vendido, 'vendidas', animar));
    } else {
      nums.appendChild(numero(servico + '.t', d.total, servico === 'Pedidos' ? 'pedidos' : 'pagamentos', animar));
    }
    c.appendChild(nums);
    if (d.status) {
      const chips = criar('div', 'chips');
      Object.keys(d.status).sort().forEach((st) => {
        const chip = criar('span', 'status-chip ' + classeDoStatus(st), st + ' ' + d.status[st]);
        chips.appendChild(chip);
      });
      if (chips.children.length) c.appendChild(chips);
    }
    const o = criar('div', 'outbox' + (d.outbox > 0 ? ' alerta' : ''), d.outbox > 0 ? '📮 ' + d.outbox + ' mensagem(ns) esperando na outbox' : '📮 outbox vazia');
    c.appendChild(o);
    return c;
  }

  async function sondarBancos() {
    if (document.hidden) return;
    let d;
    try { d = await (await fetch('/api/bancos')).json(); } catch (e) { return; }
    const b = d.bancos || {};
    $('bancos-hora').textContent = 'às ' + (d.atualizadoEm || '');
    const caixa = $('bancos');
    caixa.textContent = '';
    caixa.append(cartaoBanco('📦 Estoque', 'Estoque', b.estoque), cartaoBanco('🧾 Pedidos', 'Pedidos', b.pedidos), cartaoBanco('💳 Pagamentos', 'Pagamento', b.pagamento));
  }

  // ---------------------------------------------------------------- partida
  async function iniciar() {
    $('restaurar').addEventListener('click', () => postar('restaurar'));
    $('rodar-todas').addEventListener('click', () => { selecionar('todas'); });
    try {
      catalogo = await (await fetch('/api/cenarios')).json();
    } catch (e) {
      $('roteiro').textContent = 'Não consegui carregar os cenários. A tela de testes está ligada? Rode ./demo.sh testes.';
      return;
    }
    montarTrilho();
    await sondar(); // se já tem teste rodando, a tela já abre nele
    if (!atual) {
      const id = decodeURIComponent((location.hash || '').slice(1));
      selecionar(id === 'todas' ? 'todas' : catalogo.some((c) => c.id === id) ? id : catalogo[0].id);
    }
    setInterval(sondar, 1000);
    sondarBancos();
    setInterval(sondarBancos, 3000);
  }

  iniciar();
})();
