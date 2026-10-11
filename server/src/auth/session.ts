import cookie from '@fastify/cookie'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { getOrCreateSetting } from '../settings.js'
import { hasRole, isAdmin } from './access.js'
import { hashPassword, needsRehash, verifyPassword } from './passwords.js'
import { SqliteSessionStore, type SessionStore } from './session-store.js'
import type { AuthUser, UserRole } from './types.js'
import { findUserByApiKey, findUserByEmail, findUserById, getPasswordHash, setPasswordHash } from './users.js'

export const SESSION_COOKIE = 'KOMGA-SESSION'
export const REMEMBER_ME_COOKIE = 'komga-remember-me'
export const AUTH_TOKEN_HEADER = 'x-auth-token'
export const API_KEY_HEADER = 'x-api-key'
export const REMEMBER_ME_KEY_SETTING = 'REMEMBER_ME_KEY'

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REMEMBER_ME_TTL_MS = 365 * 24 * 60 * 60 * 1000

export type AuthMethod = 'session' | 'api-key' | 'basic' | 'remember-me'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
    sessionId?: string
    authMethod?: AuthMethod
  }
  interface FastifyInstance {
    purgeExpiredSessions(): Promise<number>
  }
}

export interface AuthPluginOptions {
  db: Kysely<DB>
  sessionTtlMs?: number
  /** Injectable for tests. */
  store?: SessionStore
}

async function authenticateCredentials(
  db: Kysely<DB>,
  email: string,
  password: string,
): Promise<AuthUser | undefined> {
  const user = await findUserByEmail(db, email)
  if (!user) return undefined

  const hash = await getPasswordHash(db, user.id)
  if (!hash || !verifyPassword(password, hash)) return undefined

  // Upgrade legacy (lower-cost) hashes transparently on a successful login.
  if (needsRehash(hash)) await setPasswordHash(db, user.id, hashPassword(password))
  return user
}

function basicCredentials(header: string | undefined): { username: string; password: string } | undefined {
  if (!header?.startsWith('Basic ')) return undefined
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return undefined
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

function signRememberMe(key: string, userId: string, expiresAt: number): string {
  const payload = `${userId}.${expiresAt}`
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}

function verifyRememberMe(key: string, token: string): string | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [userId, expiresRaw, mac] = parts as [string, string, string]
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined

  const expected = createHmac('sha256', key).update(`${userId}.${expiresAt}`).digest('base64url')
  const provided = Buffer.from(mac)
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return undefined
  return userId
}

function cookieOptions(maxAgeMs: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: Math.floor(maxAgeMs / 1000) }
}

function resolveSessionId(req: FastifyRequest): string | undefined {
  const header = req.headers[AUTH_TOKEN_HEADER]
  const fromHeader = Array.isArray(header) ? header[0] : header
  return fromHeader || req.cookies[SESSION_COOKIE]
}

function wantsRememberMe(body: Record<string, unknown>): boolean {
  const value = body['remember-me']
  return value === true || value === 'true'
}

async function recordActivity(
  db: Kysely<DB>,
  userId: string | null,
  email: string | null,
  req: FastifyRequest,
  success: boolean,
  error: string | null,
): Promise<void> {
  await db
    .insertInto('authentication_activity')
    .values({
      id: randomBytes(13).toString('hex'),
      user_id: userId,
      email,
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
      success: success ? 1 : 0,
      error,
      date_time: new Date().toISOString(),
    })
    .execute()
}

/**
 * Registers authentication for every transport Komga clients use: session
 * cookie, `X-Auth-Token`, HTTP Basic, API key and remember-me.
 */
export async function registerAuth(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const ttl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const store = opts.store ?? new SqliteSessionStore(opts.db)
  const rememberMeKey = await getOrCreateSetting(opts.db, REMEMBER_ME_KEY_SETTING, () =>
    randomBytes(32).toString('hex'),
  )

  await app.register(cookie)

  app.addHook('onRequest', async (req) => {
    const apiKey = req.headers[API_KEY_HEADER]
    const apiKeyValue = Array.isArray(apiKey) ? apiKey[0] : apiKey
    if (apiKeyValue) {
      const owner = await findUserByApiKey(opts.db, apiKeyValue)
      if (owner) {
        req.user = owner.user
        req.authMethod = 'api-key'
        return
      }
    }

    const basic = basicCredentials(req.headers.authorization)
    if (basic) {
      const user = await authenticateCredentials(opts.db, basic.username, basic.password)
      if (user) {
        req.user = user
        req.authMethod = 'basic'
        return
      }
    }

    const sessionId = resolveSessionId(req)
    if (sessionId) {
      const userId = await store.get(sessionId)
      if (userId) {
        const user = await findUserById(opts.db, userId)
        if (user) {
          req.user = user
          req.sessionId = sessionId
          req.authMethod = 'session'
          return
        }
      }
    }

    const remember = req.cookies[REMEMBER_ME_COOKIE]
    if (remember) {
      const userId = verifyRememberMe(rememberMeKey, remember)
      if (userId) {
        const user = await findUserById(opts.db, userId)
        if (user) {
          req.user = user
          req.authMethod = 'remember-me'
        }
      }
    }
  })

  app.post('/api/v1/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const email = typeof body.email === 'string' ? body.email : undefined
    const password = typeof body.password === 'string' ? body.password : undefined
    if (!email || !password) return reply.code(400).send({ message: 'Missing credentials' })

    const user = await authenticateCredentials(opts.db, email, password)
    if (!user) {
      // Attribute the failure to the account when the email is known.
      const known = await findUserByEmail(opts.db, email)
      await recordActivity(opts.db, known?.id ?? null, email, req, false, 'Bad credentials')
      return reply.code(401).send({ message: 'Invalid credentials' })
    }

    await recordActivity(opts.db, user.id, user.email, req, true, null)

    const sessionId = await store.create(user.id, ttl)
    if (AUTH_TOKEN_HEADER in req.headers) reply.header('X-Auth-Token', sessionId)
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions(ttl))

    if (wantsRememberMe(body)) {
      reply.setCookie(
        REMEMBER_ME_COOKIE,
        signRememberMe(rememberMeKey, user.id, Date.now() + REMEMBER_ME_TTL_MS),
        cookieOptions(REMEMBER_ME_TTL_MS),
      )
    }

    return { user: { id: user.id, email: user.email, roles: user.roles } }
  })

  app.post('/api/v1/login/set-cookie', async (req, reply) => {
    if (!req.sessionId) return reply.code(401).send({ message: 'Unauthorized' })
    reply.setCookie(SESSION_COOKIE, req.sessionId, cookieOptions(ttl))
    return reply.code(204).send()
  })

  app.post('/api/logout', async (req, reply) => {
    if (req.sessionId) await store.destroy(req.sessionId)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    reply.clearCookie(REMEMBER_ME_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/v1/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ message: 'Unauthorized' })
    return {
      id: req.user.id,
      email: req.user.email,
      roles: req.user.roles,
      sharedAllLibraries: req.user.sharedAllLibraries,
      sharedLibraryIds: req.user.sharedLibraryIds,
      restrictions: req.user.restrictions,
    }
  })

  app.decorate('purgeExpiredSessions', () => store.purgeExpired())
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.user) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }
  done()
}

export function requireRole(role: UserRole) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    if (!req.user) {
      reply.code(401).send({ message: 'Unauthorized' })
      return
    }
    if (!hasRole(req.user, role)) {
      reply.code(403).send({ message: 'Forbidden' })
      return
    }
    done()
  }
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.user) {
    reply.code(401).send({ message: 'Unauthorized' })
    return
  }
  if (!isAdmin(req.user)) {
    reply.code(403).send({ message: 'Forbidden' })
    return
  }
  done()
}
