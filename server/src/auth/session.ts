import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'

/** Authenticated user attached to the request by the auth plugin. */
export interface SessionUser {
  id: string
  email: string
  roles: string[]
}

interface SessionRecord {
  user: SessionUser
  expiresAt: number
}

export const SESSION_COOKIE = 'KOMGA-SESSION'
export const AUTH_TOKEN_HEADER = 'x-auth-token'
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Session storage. The in-memory implementation is used for now; a SQLite-backed
 * store replaces it once the persistence layer lands (M2).
 */
export interface SessionStore {
  create(user: SessionUser, ttlMs: number): string
  get(id: string): SessionUser | undefined
  destroy(id: string): void
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  create(user: SessionUser, ttlMs: number): string {
    const id = randomBytes(32).toString('hex')
    this.sessions.set(id, { user, expiresAt: this.now() + ttlMs })
    return id
  }

  get(id: string): SessionUser | undefined {
    const record = this.sessions.get(id)
    if (!record) return undefined
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(id)
      return undefined
    }
    return record.user
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }

  get size(): number {
    return this.sessions.size
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionId?: string
    sessionUser?: SessionUser
  }
}

/** Resolve the session id from the `X-Auth-Token` header or the session cookie. */
function resolveSessionId(req: FastifyRequest): string | undefined {
  const header = req.headers[AUTH_TOKEN_HEADER]
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (fromHeader) return fromHeader
  return req.cookies[SESSION_COOKIE]
}

function cookieOptions(ttlMs: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: Math.floor(ttlMs / 1000),
  }
}

export interface AuthPluginOptions {
  store: SessionStore
  sessionTtlMs?: number
}

/**
 * Registers session handling for both transport styles Komga clients use:
 * - the `KOMGA-SESSION` cookie (browsers), and
 * - the `X-Auth-Token` header (clients that cannot hold cookies).
 *
 * Credential verification is intentionally absent here; that lands with M4.
 */
export async function registerAuth(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const ttl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

  await app.register(cookie)

  app.addHook('onRequest', async (req) => {
    const sid = resolveSessionId(req)
    if (!sid) return
    const user = opts.store.get(sid)
    if (user) {
      req.sessionId = sid
      req.sessionUser = user
    }
  })

  app.post('/api/v1/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string }
    if (!body.email || !body.password) {
      return reply.code(400).send({ message: 'Missing credentials' })
    }

    const user: SessionUser = { id: 'user-1', email: body.email, roles: ['ADMIN'] }
    const sid = opts.store.create(user, ttl)

    if (AUTH_TOKEN_HEADER in req.headers) reply.header('X-Auth-Token', sid)
    reply.setCookie(SESSION_COOKIE, sid, cookieOptions(ttl))
    return { ok: true }
  })

  app.post('/api/v1/login/set-cookie', async (req, reply) => {
    if (!req.sessionId) return reply.code(401).send({ message: 'Unauthorized' })
    reply.setCookie(SESSION_COOKIE, req.sessionId, cookieOptions(ttl))
    return reply.code(204).send()
  })

  app.post('/api/logout', async (req, reply) => {
    if (req.sessionId) opts.store.destroy(req.sessionId)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/v1/me', async (req, reply) => {
    if (!req.sessionUser) return reply.code(401).send({ message: 'Unauthorized' })
    return req.sessionUser
  })
}

/** Pre-handler that rejects unauthenticated requests. */
export function requireUser(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.sessionUser) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }
  done()
}
