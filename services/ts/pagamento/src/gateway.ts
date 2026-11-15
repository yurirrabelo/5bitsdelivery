import { ErroInfraestrutura } from '@delivery/commons';

export type ResultadoCobranca = { status: 'APROVADO'; referencia: string } | { status: 'FALHA'; erro: string };

export interface Gateway {
  cobrar(pedidoId: number): Promise<ResultadoCobranca>;
  estornar(pedidoId: number): Promise<void>;
}

// Chama o gateway externo simulado. A chave de idempotência é o pedido: se uma réplica morrer esperando e
// outra repetir a chamada, a cobrança acontece uma vez só.
export class GatewayHttp implements Gateway {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  // Falha do gateway (503, timeout, fora do ar) = FALHA, sem nova tentativa: o prazo e a compensação já cobrem
  async cobrar(pedidoId: number): Promise<ResultadoCobranca> {
    try {
      const r = await fetch(`${this.url}/cobrancas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': String(pedidoId) },
        body: JSON.stringify({ pedidoId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (r.status !== 200) return { status: 'FALHA', erro: `gateway respondeu ${r.status}` };
      const j = (await r.json()) as { status?: string; referencia?: string };
      if (j.status !== 'APROVADO' || !j.referencia) return { status: 'FALHA', erro: 'resposta inesperada do gateway' };
      return { status: 'APROVADO', referencia: j.referencia };
    } catch (e) {
      return { status: 'FALHA', erro: (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message };
    }
  }

  // O estorno não pode se perder: se o gateway estiver fora, a mensagem fica retida e tenta de novo
  async estornar(pedidoId: number): Promise<void> {
    try {
      const r = await fetch(`${this.url}/cobrancas/${pedidoId}/estorno`, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error(`gateway respondeu ${r.status} ao estornar`);
    } catch (e) {
      throw new ErroInfraestrutura(`gateway indisponível para estornar: ${(e as Error).message}`);
    }
  }
}
