// Configuração só por variáveis de ambiente: nada de endpoint, credencial ou nome de fila fixo no código.
export function env(nome: string, padrao?: string): string {
  const valor = process.env[nome];
  if (valor !== undefined && valor !== '') return valor;
  if (padrao !== undefined) return padrao;
  throw new Error(`variável de ambiente ${nome} não definida`);
}

export function envInt(nome: string, padrao: number): number {
  return Number.parseInt(env(nome, String(padrao)), 10);
}

export const dormir = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
