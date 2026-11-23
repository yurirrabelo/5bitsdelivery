#!/usr/bin/env python3
"""Tela local para acionar os cenários de falha do professor (F1 a F8) com botões.

Roda só neste notebook (127.0.0.1) e, por baixo, chama o mesmo comando de sempre: ./demo.sh falha N.
Os cenários derrubam serviços de verdade, por isso este servidor só atende páginas de localhost. A aba Testes do painel de gestão
(http://localhost:8080/painel/) usa a mesma API; pelo link público do painel a aba não funciona, de propósito.

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

# O que cada botão aciona (o texto de "pede" é como o professor costuma perguntar)
CENARIOS = [
    {'id': '1', 'nome': 'Compensação', 'pede': 'E se o pagamento falhar? O sistema desfaz o que fez?',
     'acontece': 'O gateway passa a recusar todas as cobranças e um pedido é feito.',
     'esperado': 'Pedido cancelado, a unidade volta ao estoque e nada fica reservado.', 'tempo': 'cerca de 1 min'},
    {'id': '2', 'nome': 'Serviço morre no meio', 'pede': 'E se um serviço cair no meio do trabalho?',
     'acontece': 'A réplica do pagamento que pegou a mensagem é morta (docker kill) enquanto trabalha.',
     'esperado': 'A outra réplica assume e o pedido termina confirmado com uma cobrança só.', 'tempo': '1 a 2 min'},
    {'id': '3', 'nome': 'Mensagem duplicada', 'pede': 'E se a mesma mensagem chegar mais de uma vez?',
     'acontece': 'A mesma mensagem de reserva é publicada 5 vezes, com o mesmo identificador.',
     'esperado': 'Uma reserva só; as outras 4 são descartadas.', 'tempo': 'cerca de 1 min'},
    {'id': '4', 'nome': 'Mensagem venenosa', 'pede': 'E se chegar uma mensagem inválida que sempre dá erro?',
     'acontece': 'Uma mensagem com conteúdo inválido entra na fila do estoque, junto com pedidos normais.',
     'esperado': '3 tentativas e a mensagem vai para a fila de mortos (DLQ); os pedidos normais seguem.', 'tempo': '1 a 2 min'},
    {'id': '5', 'nome': 'Corrida pelo estoque', 'pede': 'E se muita gente pedir a última unidade ao mesmo tempo?',
     'acontece': '100 clientes pedem ao mesmo tempo as 10 unidades da promoção.',
     'esperado': 'Exatamente 10 confirmados e 90 esgotados; o estoque nunca fica negativo.', 'tempo': '1 a 2 min'},
    {'id': '6', 'nome': 'Broker fora', 'pede': 'E se o RabbitMQ cair?',
     'acontece': 'O RabbitMQ para por 30 segundos enquanto chegam pedidos.',
     'esperado': 'A API segue aceitando, as mensagens esperam na outbox e depois saem; nada se perde.', 'tempo': '2 a 3 min'},
    {'id': '6b', 'nome': 'Nuvem (MiniStack) fora', 'pede': 'E se a nuvem (S3 e segredos) ficar fora do ar?',
     'acontece': 'O MiniStack para durante uma entrega.',
     'esperado': 'O pedido segue e termina entregue; a rota fica pendente e vai para o S3 quando ele volta.', 'tempo': '2 a 3 min'},
    {'id': '7', 'nome': 'Resposta tardia', 'pede': 'E se o pagamento demorar mais que o prazo?',
     'acontece': 'O gateway passa a responder mais devagar que o prazo de pagamento.',
     'esperado': 'O pedido é cancelado no prazo e, quando a aprovação chega, ela é estornada.', 'tempo': 'cerca de 1 min'},
    {'id': '8', 'nome': 'Escala', 'pede': 'E se tivermos várias réplicas do mesmo serviço?',
     'acontece': 'O pagamento sobe para 3 réplicas e chega carga.',
     'esperado': 'A carga se divide, sem pagamento duplicado e sem cobrança repetida.', 'tempo': '2 a 3 min'},
]
IDS = {c['id'] for c in CENARIOS} | {'todas', 'restaurar'}
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')


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


def ler_saida(proc):
    for linha in proc.stdout:
        linha = ANSI.sub('', linha).rstrip('\r\n')
        with EXEC.trava:
            EXEC.linhas.append(linha)
            if len(EXEC.linhas) > 3000:
                del EXEC.linhas[:500]
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
        EXEC.id, EXEC.linhas, EXEC.inicio, EXEC.fim, EXEC.codigo, EXEC.proc = cenario, [], time.time(), None, None, proc
    threading.Thread(target=ler_saida, args=(proc,), daemon=True).start()
    return None


class Pagina(BaseHTTPRequestHandler):
    server_version = 'Testes5Bits'

    def log_message(self, *args):  # sem o ruído de cada requisição no terminal
        pass

    def _cors(self):
        # a aba "Testes" do painel de gestão (http://localhost:8080) fala com esta tela (http://localhost:8099): outra porta,
        # então o navegador pede permissão. Só páginas de localhost recebem (a verificação está em _local).
        origem = self.headers.get('Origin')
        if origem and self._local():
            self.send_header('Access-Control-Allow-Origin', origem)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _enviar(self, corpo, tipo, codigo=200):
        dados = corpo if isinstance(corpo, bytes) else corpo.encode('utf-8')
        self.send_response(codigo)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(dados)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(dados)

    def do_OPTIONS(self):  # a "consulta prévia" do navegador antes de um POST de outra porta
        self.send_response(204 if self._local() else 403)
        self._cors()
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

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
        if caminho in ('/', '/index.html'):
            return self._enviar((PASTA / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if caminho == '/logo.svg':
            return self._enviar((RAIZ / 'web' / 'comum' / 'logo.svg').read_bytes(), 'image/svg+xml')
        if caminho == '/api/cenarios':
            return self._json(CENARIOS)
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
