// Reexporta o que o serviço usa da commons (e de pg), num lugar só
export { criarEnvelope, publicarNaOutbox, transacao } from '@delivery/commons';
export type { Envelope, Logger } from '@delivery/commons';
export type { Pool, PoolClient } from 'pg';
