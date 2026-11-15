// Decisão de autoescala do consumidor do pagamento: pura (sem Docker, sem RabbitMQ), para ser testada.

export interface ConfigAutoescala {
  min: number; // AUTOSCALE_MIN: nunca menos réplicas que isto (as do compose)
  max: number; // AUTOSCALE_MAX
  mensagensPorReplica: number; // AUTOSCALE_MENSAGENS_POR_REPLICA: uma réplica a cada N mensagens na fila
  esperaSeg: number; // AUTOSCALE_ESPERA_SEG: espera mínima entre uma mudança e a próxima
}

export type Acao = 'subir' | 'descer' | 'manter';

export interface Decisao {
  acao: Acao;
  alvo: number; // quantas réplicas devem existir depois desta decisão
  motivo: string;
}

// Quantas réplicas a fila pede: ceil(mensagens / N), entre o mínimo e o máximo
export function replicasDesejadas(mensagens: number, cfg: ConfigAutoescala): number {
  return Math.min(cfg.max, Math.max(cfg.min, Math.ceil(mensagens / cfg.mensagensPorReplica)));
}

// Sobe de uma vez até o que a fila pede (a carga não espera). Desce uma réplica por vez, só depois da espera
// mínima, para não ficar subindo e descendo (flapping).
export function decidir(mensagens: number, atual: number, ultimaMudancaEm: number, agora: number, cfg: ConfigAutoescala): Decisao {
  const desejado = replicasDesejadas(mensagens, cfg);
  if (desejado === atual) return { acao: 'manter', alvo: atual, motivo: `${mensagens} mensagens na fila: ${atual} réplica(s) bastam` };

  const esperaRestanteMs = cfg.esperaSeg * 1000 - (agora - ultimaMudancaEm);
  if (esperaRestanteMs > 0) {
    return { acao: 'manter', alvo: atual, motivo: `${mensagens} mensagens, quer ${desejado}, mas em espera por mais ${Math.ceil(esperaRestanteMs / 1000)} s` };
  }
  if (desejado > atual) return { acao: 'subir', alvo: desejado, motivo: `${mensagens} mensagens na fila pedem ${desejado} réplicas (há ${atual})` };
  return { acao: 'descer', alvo: atual - 1, motivo: `${mensagens} mensagens na fila: sobra réplica (${atual} para ${desejado})` };
}
