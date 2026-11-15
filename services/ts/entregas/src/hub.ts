import type { WebSocket } from 'ws';

// Clientes do mapa ao vivo (WebSocket). O envio só acontece depois do commit da transação.
export class Hub {
  private readonly clientes = new Set<WebSocket>();

  adicionar(ws: WebSocket): void {
    this.clientes.add(ws);
    ws.on('close', () => this.clientes.delete(ws));
    ws.on('error', () => this.clientes.delete(ws));
  }

  get quantidade(): number {
    return this.clientes.size;
  }

  enviar(ws: WebSocket, msg: object): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  transmitir(msg: object): void {
    const texto = JSON.stringify(msg);
    for (const ws of this.clientes) if (ws.readyState === 1) ws.send(texto);
  }
}
