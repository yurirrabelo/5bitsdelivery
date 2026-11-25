#!/usr/bin/env python3
"""Tela simples para acionar os testes de falha do professor: um botão por teste.

Roda só neste notebook (127.0.0.1:8099) e chama o mesmo comando de sempre: ./demo.sh falha N.
Uso:  ./demo.sh testes   (o ./demo.sh subir já liga em segundo plano)
"""
import os
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PASTA = Path(__file__).resolve().parent
RAIZ = PASTA.parent.parent
PORTA = int(os.environ.get('TESTES_PORTA', '8099'))
TESTES = {'1', '2', '3', '4', '5', '6', '6b', '7', '8'}
COR = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]')  # tira as cores do terminal
ocupado = threading.Lock()  # um teste de cada vez


def achar_bash():
    """No Windows, o bash do Git (o bash.exe do WSL é outro ambiente)."""
    if os.name == 'nt':
        for c in (r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files (x86)\Git\bin\bash.exe'):
            if os.path.exists(c):
                return c
    return shutil.which('bash')


BASH = achar_bash()


class Pagina(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def local(self):
        # só atende pedidos feitos para localhost (protege contra outros sites e contra DNS rebinding)
        return self.headers.get('Host', '').rsplit(':', 1)[0] in ('localhost', '127.0.0.1')

    def do_GET(self):
        if not self.local():
            return self.send_error(403)
        if self.path.split('?')[0] not in ('/', '/index.html'):
            return self.send_error(404)
        pagina = (RAIZ / 'web' / 'testes' / 'index.html').read_bytes()  # a mesma página que o Nginx serve só para leitura
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(pagina)))
        self.end_headers()
        self.wfile.write(pagina)

    def do_POST(self):
        # o cabeçalho X-Teste impede que a página de outro site acione um teste (o navegador não deixa sem permissão)
        if not self.local() or self.headers.get('X-Teste') != 'sim':
            return self.send_error(403)
        if self.path == '/encerrar':  # o ./demo.sh parar fecha esta tela junto com o resto
            self.send_response(200)
            self.end_headers()
            return threading.Thread(target=self.server.shutdown, daemon=True).start()
        teste = self.path[len('/executar/'):] if self.path.startswith('/executar/') else ''
        if teste not in TESTES:
            return self.send_error(404)
        if BASH is None:
            return self.send_error(500, 'Não achei o bash. No Windows, abra pelo Git Bash.')
        if not ocupado.acquire(blocking=False):
            return self.send_error(409, 'Já tem um teste rodando')
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            processo = subprocess.Popen([BASH, './demo.sh', 'falha', teste], cwd=RAIZ, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=dict(os.environ, MSYS_NO_PATHCONV='1'))
            for linha in processo.stdout:
                try:
                    self.wfile.write(COR.sub(b'', linha))
                    self.wfile.flush()
                except OSError:  # a página foi fechada: o teste segue até o fim, para devolver tudo ao normal
                    pass
            processo.wait()
        finally:
            ocupado.release()


class Servidor(ThreadingHTTPServer):
    allow_reuse_address = os.name != 'nt'  # no Windows isso deixaria dois servidores dividirem a mesma porta


def main():
    try:
        servidor = Servidor(('127.0.0.1', PORTA), Pagina)
    except OSError:
        print(f'A porta {PORTA} já está em uso: a tela de testes provavelmente já está aberta em http://localhost:{PORTA}', flush=True)
        sys.exit(1)
    print(f'Tela de testes: http://localhost:{PORTA}   (só neste notebook; Ctrl+C para fechar)', flush=True)
    if os.environ.get('TESTES_ABRIR', '1') != '0':
        threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{PORTA}')).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nFechando a tela de testes.', flush=True)


if __name__ == '__main__':
    main()
