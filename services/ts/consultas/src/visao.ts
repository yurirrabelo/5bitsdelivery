import { Envelope } from '@delivery/commons';

// Modelo de LEITURA do CQRS: a escrita continua no pedidos (Postgres); aqui cada mensagem do fluxo vira um
// evento na linha do tempo do pedido (DynamoDB). O status é calculado a partir da linha do tempo.
// É eventualmente consistente: a visão pode atrasar alguns milissegundos em relação ao pedidos.

export interface EventoVisao {
  type: string;
  version: number;
  em: string; // occurredAt da mensagem
  dados: Record<string, unknown>;
}

export interface ItemVisao {
  pedidoId: number;
  clienteId?: string;
  eventos: EventoVisao[];
  atualizadoEm: string;
}

// ordem de cada passo do fluxo: o status é o do passo mais avançado que a visão já viu
const PASSOS: Record<string, { status: string; ordem: number; rotulo: string }> = {
  'estoque.reservar': { status: 'RECEBIDO', ordem: 1, rotulo: 'Pedido recebido' },
  'estoque.reservado': { status: 'AGUARDANDO_PAGAMENTO', ordem: 2, rotulo: 'Unidade reservada' },
  'estoque.esgotado': { status: 'ESGOTADO', ordem: 3, rotulo: 'Estoque esgotado' },
  'pedido.confirmado': { status: 'CONFIRMADO', ordem: 3, rotulo: 'Pedido confirmado' },
  'pedido.cancelado': { status: 'CANCELADO', ordem: 3, rotulo: 'Pedido cancelado' },
  'pagamento.estornado': { status: 'ESTORNADO', ordem: 4, rotulo: 'Pagamento estornado' },
  'entrega.atribuida': { status: 'EM_ENTREGA', ordem: 4, rotulo: 'Entregador a caminho' },
  'entrega.concluida': { status: 'ENTREGUE', ordem: 5, rotulo: 'Entrega concluída' },
};

const ROTULOS_EXTRAS: Record<string, string> = {
  'pagamento.cobrar': 'Cobrança enviada',
  'pagamento.aprovado': 'Pagamento aprovado',
  'pagamento.recusado': 'Pagamento recusado',
  'pagamento.estornar': 'Estorno solicitado',
};

// Só os dados que a visão precisa de cada mensagem. pedido.confirmado: a v1 traz o destino no payload,
// a v2 dentro de "entrega" (a visão entende as duas).
export function extrairDados(e: Envelope): Record<string, unknown> {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'pedido.cancelado':
    case 'pagamento.recusado':
      return { motivo: p.motivo };
    case 'pagamento.aprovado':
      return { referencia: p.referencia };
    case 'entrega.atribuida':
      return { entregadorId: p.entregadorId, entregadorNome: p.entregadorNome };
    case 'entrega.concluida':
      return { entregadorId: p.entregadorId, modo: p.modo };
    case 'pedido.confirmado': {
      const entrega = e.version >= 2 ? p.entrega : p;
      return { destino: entrega?.destino ?? null, entregadorPreferidoId: entrega?.entregadorPreferidoId ?? null };
    }
    default:
      return {};
  }
}

export function criarEvento(e: Envelope): EventoVisao {
  return { type: e.type, version: e.version, em: e.occurredAt, dados: extrairDados(e) };
}

export interface PedidoVisao {
  id: number;
  status: string;
  motivo: string | null;
  destino: unknown;
  entregadorId: number | null;
  criadoEm: string | null;
  atualizadoEm: string;
  linhaDoTempo: { passo: string; em: string }[];
  consistencia: 'eventual';
}

// Calcula o pedido a partir da linha do tempo (as mensagens podem chegar fora de ordem: vale o passo mais avançado)
export function projetar(item: ItemVisao): PedidoVisao {
  const eventos = [...item.eventos].sort((a, b) => a.em.localeCompare(b.em));
  let atual: { status: string; ordem: number } | null = null;
  let motivo: string | null = null;
  let destino: unknown = null;
  let entregadorId: number | null = null;
  for (const ev of eventos) {
    const passo = PASSOS[ev.type];
    if (passo && (!atual || passo.ordem >= atual.ordem)) atual = passo;
    if (ev.type === 'pedido.cancelado') motivo = (ev.dados.motivo as string) ?? null;
    if (ev.type === 'pedido.confirmado' && ev.dados.destino) destino = ev.dados.destino;
    if (ev.type === 'entrega.atribuida') entregadorId = (ev.dados.entregadorId as number) ?? null;
  }
  return {
    id: item.pedidoId,
    status: atual?.status ?? 'RECEBIDO',
    motivo,
    destino,
    entregadorId,
    criadoEm: eventos[0]?.em ?? null,
    atualizadoEm: item.atualizadoEm,
    linhaDoTempo: eventos.map((ev) => ({ passo: PASSOS[ev.type]?.rotulo ?? ROTULOS_EXTRAS[ev.type] ?? ev.type, em: ev.em })),
    consistencia: 'eventual',
  };
}
