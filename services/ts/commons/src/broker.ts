import amqp, { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import { Logger } from './logger';

// Quem sabe publicar uma mensagem no broker (o Broker real, ou um falso nos testes)
export interface Publicador {
  conectado(): boolean;
  publicar(exchange: string, routingKey: string, corpo: string, props: PropsMensagem): Promise<void>;
}

export interface PropsMensagem {
  messageId: string;
  correlationId: string;
  type: string;
  traceparent?: string;
}

// Conexão com o RabbitMQ. O amqp-connection-manager reconecta sozinho e refaz os consumidores.
export class Broker implements Publicador {
  readonly conexao: AmqpConnectionManager;
  private readonly canalPublicacao: ChannelWrapper;

  constructor(url: string, private readonly log: Logger) {
    this.conexao = amqp.connect([url], { heartbeatIntervalInSeconds: 10, reconnectTimeInSeconds: 2 });
    this.conexao.on('connect', () => log.info('conectado ao RabbitMQ'));
    this.conexao.on('disconnect', ({ err }) => log.warn({ err: err?.message }, 'desconectado do RabbitMQ; reconectando'));
    this.canalPublicacao = this.conexao.createChannel({ name: 'publicacao' });
  }

  conectado(): boolean {
    return this.conexao.isConnected();
  }

  // Resolve quando o broker confirma a mensagem (publisher confirm). Mensagem persistente.
  async publicar(exchange: string, routingKey: string, corpo: string, props: PropsMensagem): Promise<void> {
    await this.canalPublicacao.publish(exchange, routingKey, Buffer.from(corpo, 'utf8'), {
      persistent: true,
      contentType: 'application/json',
      messageId: props.messageId,
      correlationId: props.correlationId,
      type: props.type,
      headers: props.traceparent ? { traceparent: props.traceparent } : {},
      timeout: 5000,
    });
  }

  async fechar(): Promise<void> {
    await this.canalPublicacao.close().catch(() => undefined);
    await this.conexao.close().catch(() => undefined);
  }
}
