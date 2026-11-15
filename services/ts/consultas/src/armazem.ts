import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Envelope, ErroInfraestrutura } from '@delivery/commons';
import { ItemVisao, criarEvento } from './visao';

// Onde a visão fica guardada. A implementação real usa o DynamoDB; os testes usam a memória.
export interface Armazem {
  // Grava a mensagem na inbox E o evento na visão, de forma atômica. 'duplicada' se o messageId já foi visto.
  registrar(e: Envelope): Promise<'processada' | 'duplicada'>;
  ler(pedidoId: number): Promise<ItemVisao | null>;
  listar(limite: number): Promise<ItemVisao[]>;
}

export const pk = (pedidoId: number | string) => `PEDIDO#${pedidoId}`;

const ERROS_DE_REDE = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];

export class ArmazemDynamo implements Armazem {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    endpoint: string,
    region: string,
    private readonly tabela: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint, region }), { marshallOptions: { removeUndefinedValues: true } });
  }

  // TransactWriteItems: a inbox (condição de não existir) e a atualização da visão acontecem juntas ou não acontecem
  async registrar(e: Envelope): Promise<'processada' | 'duplicada'> {
    const pedidoId = Number(e.payload?.pedidoId);
    const agora = new Date().toISOString();
    const clienteId = e.type === 'estoque.reservar' ? (e.payload?.clienteId as string | undefined) : undefined;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tabela,
                Item: { pk: `MSG#${e.messageId}`, type: e.type, processadaEm: agora },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.tabela,
                Key: { pk: pk(pedidoId) },
                UpdateExpression:
                  'SET eventos = list_append(if_not_exists(eventos, :vazio), :novo), pedidoId = :id, atualizadoEm = :agora' +
                  (clienteId ? ', clienteId = if_not_exists(clienteId, :cli)' : ''),
                ExpressionAttributeValues: {
                  ':vazio': [],
                  ':novo': [criarEvento(e)],
                  ':id': pedidoId,
                  ':agora': agora,
                  ...(clienteId ? { ':cli': clienteId } : {}),
                },
              },
            },
          ],
        }),
      );
      return 'processada';
    } catch (erro) {
      const err = erro as { name?: string; CancellationReasons?: { Code?: string }[]; code?: string; cause?: { code?: string } };
      if (err.name === 'TransactionCanceledException' && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return 'duplicada'; // a inbox já tinha o messageId
      }
      // DynamoDB fora do ar não é culpa da mensagem: o consumidor segura e tenta de novo
      const codigo = err.code ?? err.cause?.code ?? '';
      if (ERROS_DE_REDE.includes(codigo) || err.name === 'TimeoutError') throw new ErroInfraestrutura(`DynamoDB indisponível: ${(erro as Error).message}`);
      throw erro;
    }
  }

  async ler(pedidoId: number): Promise<ItemVisao | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.tabela, Key: { pk: pk(pedidoId) } }));
    return (r.Item as ItemVisao | undefined) ?? null;
  }

  // Lista os pedidos mais recentes. Um Scan serve para o volume da demonstração.
  async listar(limite: number): Promise<ItemVisao[]> {
    const itens: ItemVisao[] = [];
    let chave: Record<string, unknown> | undefined;
    for (let pagina = 0; pagina < 20; pagina++) {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.tabela,
          FilterExpression: 'begins_with(pk, :p)',
          ExpressionAttributeValues: { ':p': 'PEDIDO#' },
          ExclusiveStartKey: chave,
        }),
      );
      itens.push(...((r.Items ?? []) as ItemVisao[]));
      chave = r.LastEvaluatedKey;
      if (!chave) break;
    }
    return itens.sort((a, b) => b.pedidoId - a.pedidoId).slice(0, limite);
  }
}

// Para os testes: o mesmo contrato do Armazem, sem DynamoDB
export class ArmazemMemoria implements Armazem {
  readonly mensagens = new Set<string>();
  readonly itens = new Map<number, ItemVisao>();

  async registrar(e: Envelope): Promise<'processada' | 'duplicada'> {
    if (this.mensagens.has(e.messageId)) return 'duplicada';
    this.mensagens.add(e.messageId);
    const pedidoId = Number(e.payload?.pedidoId);
    const item = this.itens.get(pedidoId) ?? { pedidoId, eventos: [], atualizadoEm: '' };
    item.eventos.push(criarEvento(e));
    item.atualizadoEm = new Date().toISOString();
    if (e.type === 'estoque.reservar' && e.payload?.clienteId && !item.clienteId) item.clienteId = e.payload.clienteId;
    this.itens.set(pedidoId, item);
    return 'processada';
  }

  async ler(pedidoId: number) {
    return this.itens.get(pedidoId) ?? null;
  }

  async listar(limite: number) {
    return [...this.itens.values()].sort((a, b) => b.pedidoId - a.pedidoId).slice(0, limite);
  }
}
