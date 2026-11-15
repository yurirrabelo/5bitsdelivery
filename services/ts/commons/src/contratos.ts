import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config';
import { Envelope } from './envelope';

// Erro da mensagem em si (JSON inválido, contrato violado): vai para a DLQ após MAX_TENTATIVAS.
export class MensagemInvalida extends Error {}

// Valida o envelope e o payload contra contracts/schemas, na versão informada pela mensagem.
export class ValidadorContratos {
  private readonly ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  private readonly validaEnvelope: ValidateFunction;
  private readonly validaPayload = new Map<string, ValidateFunction>();
  private readonly ids = new Map<string, string>(); // nome do arquivo -> $id do schema

  constructor(dirSchemas: string = join(env('CONTRACTS_DIR', '/app/contracts'), 'schemas')) {
    addFormats(this.ajv);
    for (const arquivo of readdirSync(dirSchemas).filter((f) => f.endsWith('.schema.json'))) {
      const schema = JSON.parse(readFileSync(join(dirSchemas, arquivo), 'utf8'));
      this.ajv.addSchema(schema);
      this.ids.set(arquivo, schema.$id);
    }
    this.validaEnvelope = this.ajv.getSchema(this.ids.get('envelope.schema.json')!)!;
  }

  validar(dados: unknown): Envelope {
    if (!this.validaEnvelope(dados)) {
      throw new MensagemInvalida(`envelope inválido: ${this.ajv.errorsText(this.validaEnvelope.errors)}`);
    }
    const envelope = dados as Envelope;
    const chave = `${envelope.type}.v${envelope.version}.schema.json`;
    let valida = this.validaPayload.get(chave);
    if (!valida) {
      const id = this.ids.get(chave);
      valida = id ? this.ajv.getSchema(id) : undefined;
      if (!valida) throw new MensagemInvalida(`contrato desconhecido: ${envelope.type} v${envelope.version}`);
      this.validaPayload.set(chave, valida);
    }
    if (!valida(envelope.payload)) {
      throw new MensagemInvalida(`payload de ${envelope.type} inválido: ${this.ajv.errorsText(valida.errors)}`);
    }
    return envelope;
  }
}
