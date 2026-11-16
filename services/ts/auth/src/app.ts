import { metrics } from '@opentelemetry/api';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export type Papel = 'operador' | 'entregador' | 'cliente';

export interface Usuario {
  id: string;
  nome: string;
  role: 'operador' | 'entregador';
  entregadorId: number | null;
  hash: string; // bcrypt da senha
}

export interface ConfigAuth {
  segredoJwt: string;
  expiracaoHoras: number;
  eventoCodigo: string;
  usuarios: Usuario[];
}

interface Claims {
  sub: string;
  nome: string;
  role: Papel;
  entregadorId?: number;
}

// delivery_sessoes_total{papel}: quantas pessoas entraram (cliente do QR, entregador, operador)
const sessoes = metrics.getMeter('delivery.auth').createCounter('delivery_sessoes_total', { description: 'Sessões iniciadas, por papel' });

// Hash falso para gastar o mesmo tempo quando o usuário não existe
const HASH_FALSO = bcrypt.hashSync('senha-que-ninguem-tem', 10);

export function criarUsuario(id: string, nome: string, role: 'operador' | 'entregador', entregadorId: number | null, senha: string): Usuario {
  return { id, nome, role, entregadorId, hash: bcrypt.hashSync(senha, 10) };
}

// Token do header Authorization ou, para o WebSocket do navegador (que não envia headers),
// do parâmetro ?token= presente em X-Original-URI.
function extrairToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const original = req.headers['x-original-uri'];
  if (typeof original === 'string') {
    try {
      return new URL(original, 'http://x').searchParams.get('token');
    } catch {
      return null;
    }
  }
  return null;
}

export function registrarRotasAuth(app: FastifyInstance, cfg: ConfigAuth): void {
  const expiresIn = cfg.expiracaoHoras * 3600;
  const emitir = (claims: Claims) => jwt.sign(claims, cfg.segredoJwt, { algorithm: 'HS256', expiresIn });

  app.get('/health', async () => ({ status: 'ok' }));

  // Operador e entregador: usuário e senha. Erro sempre 401 genérico.
  app.post('/api/auth/login', {
    schema: { body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 200 } } } },
    attachValidation: true,
  }, async (req, reply) => {
    const corpo = req.body as { username?: string; password?: string } | undefined;
    const usuario = req.validationError ? undefined : cfg.usuarios.find((u) => u.id === corpo?.username);
    const ok = await bcrypt.compare(corpo?.password ?? '', usuario?.hash ?? HASH_FALSO);
    if (!usuario || !ok) return reply.code(401).send({ erro: 'credenciais inválidas' });
    const claims: Claims = { sub: usuario.id, nome: usuario.nome, role: usuario.role, ...(usuario.entregadorId ? { entregadorId: usuario.entregadorId } : {}) };
    sessoes.add(1, { papel: usuario.role });
    return {
      token: emitir(claims),
      expiresIn,
      usuario: { id: usuario.id, nome: usuario.nome, role: usuario.role, entregadorId: usuario.entregadorId },
    };
  });

  // Cliente do QR: apelido + código do evento, sem senha
  app.post('/api/auth/cliente', {
    schema: { body: { type: 'object', required: ['apelido', 'codigo'], properties: { apelido: { type: 'string', minLength: 1, maxLength: 20 }, codigo: { type: 'string', maxLength: 200 } } } },
    attachValidation: true,
  }, async (req, reply) => {
    const corpo = req.body as { apelido?: string; codigo?: string } | undefined;
    const apelido = corpo?.apelido?.trim();
    if (req.validationError || !apelido || corpo?.codigo !== cfg.eventoCodigo) {
      return reply.code(401).send({ erro: 'código do evento inválido' });
    }
    sessoes.add(1, { papel: 'cliente' });
    return { token: emitir({ sub: `c-${randomUUID()}`, nome: apelido, role: 'cliente' }), expiresIn };
  });

  // Chamado pelo Nginx (auth_request). Nunca exposto para fora.
  app.get('/auth/validate', async (req, reply) => {
    const token = extrairToken(req);
    if (!token) return reply.code(401).send();
    try {
      const c = jwt.verify(token, cfg.segredoJwt, { algorithms: ['HS256'] }) as Claims;
      reply.header('X-User-Id', c.sub);
      reply.header('X-User-Name', encodeURIComponent(c.nome)); // headers só aceitam ASCII
      reply.header('X-User-Role', c.role);
      if (c.entregadorId) reply.header('X-Entregador-Id', String(c.entregadorId));
      return reply.code(200).send();
    } catch {
      return reply.code(401).send();
    }
  });

  // Identidade chegando pelos headers X-User-* que o Nginx repassa
  app.get('/api/auth/me', async (req, reply) => {
    const id = req.headers['x-user-id'];
    if (!id) return reply.code(401).send();
    const ent = req.headers['x-entregador-id'];
    return {
      id,
      nome: decodeURIComponent(String(req.headers['x-user-name'] ?? '')),
      role: req.headers['x-user-role'],
      entregadorId: ent ? Number(ent) : null,
    };
  });

  // O painel usa o código para montar o QR
  app.get('/api/auth/evento', async (req, reply) => {
    if (req.headers['x-user-role'] !== 'operador') return reply.code(403).send({ erro: 'apenas operador' });
    return { codigo: cfg.eventoCodigo };
  });
}
