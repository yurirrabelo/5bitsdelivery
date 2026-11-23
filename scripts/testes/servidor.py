#!/usr/bin/env python3
"""Tela local para acionar os cenários de falha do professor (F1 a F8) com botões.

Roda só neste notebook (127.0.0.1) e, por baixo, chama o mesmo comando de sempre: ./demo.sh falha N.
Os cenários derrubam serviços de verdade, por isso este servidor só atende páginas de localhost. O painel de gestão
(http://localhost:8080/painel/) tem um botão "Testes" que abre esta tela; pelo link público do painel o botão não funciona,
de propósito.

O texto de cada cenário (o que o professor pede, os passos e o porquê de cada um, o resultado esperado) está em cenarios.json.

Uso:  ./demo.sh subir  liga em segundo plano;  ./demo.sh testes  liga (se preciso) e abre http://localhost:8099 (Ctrl+C para fechar)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PASTA = Path(__file__).resolve().parent
RAIZ = PASTA.parent.parent
PORTA = int(os.environ.get('TESTES_PORTA', '8099'))
LOCAIS = {'localhost', '127.0.0.1', '[::1]'}

# O que cada botão aciona: o que o professor pede, os passos (com o porquê de cada um), o resultado esperado...
CENARIOS = json.loads((PASTA / 'cenarios.json').read_text(encoding='utf-8'))
IDS = {c['id'] for c in CENARIOS} | {'todas', 'restaurar'}
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')

# Os arquivos da tela (o resto é a API)
ARQUIVOS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/testes.css': ('testes.css', 'text/css; charset=utf-8'),
    '/testes.js': ('testes.js', 'text/javascript; charset=utf-8'),
}

# O estado de cada banco, para a tela mostrar "ao vivo" o que o teste está fazendo (cada serviço tem o seu banco).
# Cada consulta devolve um JSON de uma linha.
OUTBOX = "(SELECT count(*) FROM outbox WHERE publicada_em IS NULL)"
POR_STATUS = "coalesce((SELECT json_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM {t} GROUP BY status) x), '{{}}'::json)"
BANCOS = {
    'estoque': "SELECT json_build_object('disponivel', disponivel, 'reservado', reservado, 'vendido', vendido, 'total', total, "
               f"'outbox', {OUTBOX}) FROM estoque WHERE produto_id = 1",
    'pedidos': "SELECT json_build_object('total', (SELECT count(*) FROM pedidos), "
               f"'status', {POR_STATUS.format(t='pedidos')}, 'outbox', {OUTBOX})",
    'pagamento': "SELECT json_build_object('total', (SELECT count(*) FROM pagamentos), "
                 f"'status', {POR_STATUS.format(t='pagamentos')}, 'outbox', {OUTBOX})",
}


def achar_bash():
    """O bash do Git (Windows) ou o do sistema. Evita o bash.exe do WSL, que é outro ambiente."""
    if os.name == 'nt':
        for c in (r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files (x86)\Git\bin\bash.exe'):
            if os.path.exists(c):
                return c
    return shutil.which('bash')


BASH = achar_bash()


class Execucao:
    """O que está rodando agora (ou o último que rodou): um de cada vez."""

    def __init__(self):
        self.trava = threading.Lock()
        self.id = None
        self.linhas = []
        self.inicio = None
        self.fim = None
        self.codigo = None
        self.proc = None
        self.foto = None  # o estado dos bancos quando o teste mostra o "Resultado:" (o fim do teste devolve tudo ao normal)

    def rodando(self):
        return self.proc is not None and self.fim is None

    def resultado(self):
        if self.rodando() or self.fim is None:
            return None
        texto = '\n'.join(self.linhas[-40:])
        if re.search(r'^\S+: PASSOU', texto, re.M) or (self.id == 'restaurar' and self.codigo == 0):
            return 'passou'
        return 'falhou'

    def dica(self):
        for linha in reversed(self.linhas):
            if linha.startswith('Mostre agora:'):
                return linha[len('Mostre agora:'):].strip()
        return ''


EXEC = Execucao()


def tirar_foto(id_teste):
    """Guarda o estado dos bancos de agora: é o que o teste deixou, antes de o script devolver o estoque ao normal."""
    dados = bancos(forcar=True)
    with EXEC.trava:
        if EXEC.id == id_teste:
            EXEC.foto = dados


def ler_saida(proc):
    for linha in proc.stdout:
        linha = ANSI.sub('', linha).rstrip('\r\n')
        with EXEC.trava:
            EXEC.linhas.append(linha)
            if len(EXEC.linhas) > 3000:
                del EXEC.linhas[:500]
            id_teste = EXEC.id
        if linha.startswith('Resultado:') and id_teste not in ('restaurar', 'todas'):
            threading.Thread(target=tirar_foto, args=(id_teste,), daemon=True).start()
    proc.wait()
    with EXEC.trava:
        EXEC.codigo = proc.returncode
        EXEC.fim = time.time()


def iniciar(cenario):
    if BASH is None:
        return 'Não achei o bash. No Windows, instale o Git for Windows e abra pelo Git Bash.'
    with EXEC.trava:
        if EXEC.rodando():
            return 'Já tem um teste rodando. Espere ele terminar.'
        if cenario == 'restaurar':
            comando = [BASH, '-c', 'source scripts/falhas/lib.sh; restaurar']
        else:
            comando = [BASH, './demo.sh', 'falha', cenario]
        ambiente = dict(os.environ, MSYS_NO_PATHCONV='1', PYTHONUNBUFFERED='1')
        proc = subprocess.Popen(comando, cwd=RAIZ, env=ambiente, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', bufsize=1)
        EXEC.id, EXEC.linhas, EXEC.inicio, EXEC.fim, EXEC.codigo, EXEC.proc, EXEC.foto = cenario, [], time.time(), None, None, proc, None
    threading.Thread(target=ler_saida, args=(proc,), daemon=True).start()
    return None


# ---------------------------------------------------------------- estado dos bancos
_bancos = {'em': 0.0, 'dados': {}}
_trava_bancos = threading.Lock()


def _consultar(banco):
    """Roda a consulta no Postgres do serviço (docker compose exec) e devolve o JSON, ou None se o banco não respondeu."""
    comando = ['docker', 'compose', 'exec', '-T', f'pg-{banco}', 'psql', '-U', banco, '-d', banco, '-Atc', BANCOS[banco]]
    extra = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        r = subprocess.run(comando, cwd=RAIZ, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=8,
                           stdin=subprocess.DEVNULL, **extra)
        return json.loads(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def bancos(forcar=False):
    """O estado dos bancos de estoque, pedidos e pagamento. Guarda o resultado por 2 s: a tela pergunta de 3 em 3 s."""
    with _trava_bancos:
        if not forcar and time.time() - _bancos['em'] < 2.0:
            return _bancos['dados']
        resultado = {}
        fios = [threading.Thread(target=lambda b=b: resultado.__setitem__(b, _consultar(b))) for b in BANCOS]
        for f in fios:
            f.start()
        for f in fios:
            f.join()
        _bancos['dados'] = {'bancos': resultado, 'atualizadoEm': time.strftime('%H:%M:%S')}
        _bancos['em'] = time.time()
        return _bancos['dados']


class Pagina(BaseHTTPRequestHandler):
    server_version = 'Testes5Bits'

    def log_message(self, *args):  # sem o ruído de cada requisição no terminal
        pass

    def _cors(self):
        # o botão "Testes" do painel de gestão (http://localhost:8080) pergunta a esta tela (http://localhost:8099) se ela está
        # ligada: outra porta, então o navegador pede permissão. Só páginas de localhost recebem (a verificação está em _local).
        origem = self.headers.get('Origin')
        if origem and self._local():
            self.send_header('Access-Control-Allow-Origin', origem)
            self.send_header('Vary', 'Origin')

    def _enviar(self, corpo, tipo, codigo=200):
        dados = corpo if isinstance(corpo, bytes) else corpo.encode('utf-8')
        self.send_response(codigo)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(dados)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(dados)

    def _json(self, objeto, codigo=200):
        self._enviar(json.dumps(objeto, ensure_ascii=False), 'application/json; charset=utf-8', codigo)

    def _local(self):
        # só aceita pedidos feitos para localhost (protege contra páginas de outros sites e contra DNS rebinding)
        host = self.headers.get('Host', '').rsplit(':', 1)[0]
        origem = self.headers.get('Origin')
        if origem:
            origem = origem.split('://', 1)[-1].rsplit(':', 1)[0]
        return host in LOCAIS and (origem is None or origem in LOCAIS)

    def do_GET(self):
        if not self._local():
            return self._enviar('acesso negado', 'text/plain; charset=utf-8', 403)
        caminho, _, consulta = self.path.partition('?')
        if caminho in ARQUIVOS:
            arquivo, tipo = ARQUIVOS[caminho]
            return self._enviar((PASTA / arquivo).read_bytes(), tipo)
        if caminho == '/logo.svg':
            return self._enviar((RAIZ / 'web' / 'comum' / 'logo.svg').read_bytes(), 'image/svg+xml')
        if caminho == '/api/cenarios':
            return self._json(CENARIOS)
        if caminho == '/api/bancos':
            return self._json(bancos())
        if caminho == '/api/estado':
            try:
                desde = int(dict(p.split('=', 1) for p in consulta.split('&') if '=' in p).get('desde', 0))
            except ValueError:
                desde = 0
            with EXEC.trava:
                decorrido = (EXEC.fim or time.time()) - EXEC.inicio if EXEC.inicio else 0
                return self._json({
                    'id': EXEC.id,
                    'rodando': EXEC.rodando(),
                    'resultado': EXEC.resultado(),
                    'dica': EXEC.dica(),
                    'foto': EXEC.foto,
                    'decorrido': round(decorrido),
                    'total': len(EXEC.linhas),
                    'linhas': EXEC.linhas[desde:],
                })
        self._enviar('não encontrado', 'text/plain; charset=utf-8', 404)

    def do_POST(self):
        if not self._local() or 'application/json' not in self.headers.get('Content-Type', ''):
            return self._enviar('acesso negado', 'text/plain; charset=utf-8', 403)
        if self.path == '/api/encerrar':  # ./demo.sh parar fecha a tela de testes junto com o resto
            self._json({'ok': True})
            return threading.Thread(target=self.server.shutdown, daemon=True).start()
        if self.path != '/api/executar':
            return self._enviar('não encontrado', 'text/plain; charset=utf-8', 404)
        try:
            corpo = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        except ValueError:
            corpo = {}
        cenario = str(corpo.get('id', ''))
        if cenario not in IDS:
            return self._json({'erro': 'cenário desconhecido'}, 400)
        erro = iniciar(cenario)
        if erro:
            return self._json({'erro': erro}, 409)
        self._json({'ok': True})


class Servidor(ThreadingHTTPServer):
    daemon_threads = True


def main():
    try:
        servidor = Servidor(('127.0.0.1', PORTA), Pagina)
    except OSError:
        print(f'A porta {PORTA} já está em uso: a tela de testes provavelmente já está aberta em http://localhost:{PORTA}', flush=True)
        sys.exit(1)
    url = f'http://localhost:{PORTA}'
    print(f'Tela de testes do professor: {url}   (só neste notebook; Ctrl+C para fechar)', flush=True)
    if os.environ.get('TESTES_ABRIR', '1') != '0':
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nFechando a tela de testes.', flush=True)


if __name__ == '__main__':
    main()
