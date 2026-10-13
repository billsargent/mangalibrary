import cookie from '@fastify/cookie'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { getOrCreateSetting, getRememberMeDurationDays } from '../settings.js'
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
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The remember-me signing key, read from the settings on first use.
 *
 * Cached because every request asks for it, but droppable: regenerating the key
 * from the settings API must invalidate the cookies signed with the old one,
 * not just the ones issued after the next restart.
 */
let rememberMeKeyCache: string | undefined

async function rememberMeKey(db: Kysely<DB>): Promise<string> {
  if (rememberMeKeyCache !== undefined) return rememberMeKeyCache
  rememberMeKeyCache = await getOrCreateSetting(db, REMEMBER_ME_KEY_SETTING, () => randomBytes(32).toString('hex'))
  return rememberMeKeyCache
}

/** Forget the cached remember-me key, so the next request reads it again. */
export function invalidateRememberMeKey(): void {
  rememberMeKeyCache = undefined
}

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

async function authenticateCredentials(db: Kysely<DB>, email: string, password: string): Promise<AuthUser | undefined> {
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

/**
 * Whether a request is a browser signing in.
 *
 * A browser sends its credentials once - the forked UI sends them as HTTP Basic on
 * `GET /api/v2/users/me` - and expects a session back for everything that follows.
 * It says so with the header the reference's UI has always sent, which is also what
 * stops Spring from answering a sign-in with a redirect.
 */
function wantsSession(req: FastifyRequest): boolean {
  const header = req.headers['x-requested-with']
  const value = Array.isArray(header) ? header[0] : header
  return typeof value === 'string' && value.toLowerCase() === 'xmlhttprequest'
}

/**
 * Whether the caller asked to be remembered.
 *
 * The reference reads this as a request parameter, so both a query and a body are
 * looked at: the UI sends it in the query of its sign-in request.
 */
function wantsRememberMe(req: FastifyRequest): boolean {
  const query = (req.query ?? {}) as Record<string, unknown>
  const body = (req.body ?? {}) as Record<string, unknown>
  return [query['remember-me'], body['remember-me']].some((value) => value === true || value === 'true')
}

/**
 * Record an authentication event.
 *
 * Exported because registration is a credential event too: a new account is made
 * with a password, and both the attempt and its outcome belong in the same log as a
 * sign-in.
 */
export async function recordActivity(
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

  await app.register(cookie)
  /**
   * Give a caller that signed in with Basic credentials a session to keep.
   *
   * Only a request that says it is a browser gets one - the forked UI sends
   * `X-Requested-With` - so a script or a device sending its credentials on every
   * request does not leave a session behind for each one. The sign-in is recorded as an
   * authentication activity, which is what the reference does for a Basic sign-in too.
   *
   * The cookie the browser already holds decides nothing by itself: what matters is
   * whether it still resolves to a session, and whose. A cookie from a session that has
   * expired, been purged, or belongs to another account is replaced, because otherwise a
   * sign-in that succeeded would leave the browser holding a cookie the server does not
   * know - authenticated for that one request, and a stranger to every request after it.
   * That is the difference between a browser that signs in and one that bounces back to
   * the login page for ever.
   */
  const startSession = async (req: FastifyRequest, reply: FastifyReply, user: AuthUser): Promise<void> => {
    if (!wantsSession(req)) return

    const presented = req.cookies[SESSION_COOKIE]
    if (presented !== undefined) {
      const owner = await store.get(presented)
      if (owner === user.id) {
        // The browser is already signed in as this account: keep what it has.
        req.log.debug({ email: user.email, session: presented.slice(0, 8) }, 'sign-in: session already held')
        return
      }

      // A session nobody can use any more, or one that belongs to somebody else.
      await store.destroy(presented)
      req.log.info(
        { email: user.email, session: presented.slice(0, 8), replaced: owner !== undefined },
        'sign-in: replaced a session the browser could not use',
      )
    }

    const sessionId = await store.create(user.id, ttl)
    req.sessionId = sessionId
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions(ttl))
    await recordActivity(opts.db, user.id, user.email, req, true, null)
    req.log.info(
      { email: user.email, session: sessionId.slice(0, 8), rememberMe: wantsRememberMe(req) },
      'sign-in: session created',
    )

    if (wantsRememberMe(req)) {
      const ttlMs = (await getRememberMeDurationDays(opts.db)) * DAY_MS
      reply.setCookie(
        REMEMBER_ME_COOKIE,
        signRememberMe(await rememberMeKey(opts.db), user.id, Date.now() + ttlMs),
        cookieOptions(ttlMs),
      )
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    const apiKey = req.headers[API_KEY_HEADER]
    const apiKeyValue = Array.isArray(apiKey) ? apiKey[0] : apiKey
    const presentedSession = resolveSessionId(req)
    const presentedBasic = basicCredentials(req.headers.authorization)
    // What a hard-to-explain sign-in needs first: which credentials actually arrived on
    // this request. Never the password, never a whole session id - enough to tell a
    // mechanism that was not tried from one that was tried and refused.
    req.log.debug(
      {
        method: req.method,
        url: req.url,
        apiKey: apiKeyValue !== undefined,
        basic: presentedBasic !== undefined,
        session: presentedSession !== undefined ? presentedSession.slice(0, 8) : undefined,
        rememberMe: req.cookies[REMEMBER_ME_COOKIE] !== undefined,
        browser: wantsSession(req),
      },
      'authentication: credentials presented',
    )

    if (apiKeyValue) {
      const owner = await findUserByApiKey(opts.db, apiKeyValue)
      if (owner) {
        req.user = owner.user
        req.authMethod = 'api-key'
        return
      }
    }

    if (presentedBasic) {
      const user = await authenticateCredentials(opts.db, presentedBasic.username, presentedBasic.password)
      if (user) {
        req.user = user
        req.authMethod = 'basic'
        await startSession(req, reply, user)
        return
      }
      req.log.info({ email: presentedBasic.username }, 'authentication: Basic credentials refused')
    }

    const sessionId = presentedSession
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
      // A signed-in browser holding a cookie the server cannot resolve: without this
      // line the only evidence of it is a 401 on an otherwise anonymous-looking request.
      req.log.info(
        { session: sessionId.slice(0, 8), resolved: userId !== undefined },
        'authentication: session cookie did not sign the caller in',
      )
    }

    const remember = req.cookies[REMEMBER_ME_COOKIE]
    if (remember) {
      const userId = verifyRememberMe(await rememberMeKey(opts.db), remember)
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

    if (wantsRememberMe(req)) {
      const ttlMs = (await getRememberMeDurationDays(opts.db)) * DAY_MS
      reply.setCookie(
        REMEMBER_ME_COOKIE,
        signRememberMe(await rememberMeKey(opts.db), user.id, Date.now() + ttlMs),
        cookieOptions(ttlMs),
      )
    }

    return { user: { id: user.id, email: user.email, roles: user.roles } }
  })

  // The reference answers this on GET. POST is kept: it is what this server
  // answered first, and something may be calling it.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/login/set-cookie',
    handler: async (req, reply) => {
      if (!req.sessionId) return reply.code(401).send({ message: 'Unauthorized' })
      reply.setCookie(SESSION_COOKIE, req.sessionId, cookieOptions(ttl))
      return reply.code(204).send()
    },
  })

  // On either verb, as the reference signs out on either.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/logout',
    handler: async (req, reply) => {
      if (req.sessionId) await store.destroy(req.sessionId)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      reply.clearCookie(REMEMBER_ME_COOKIE, { path: '/' })
      return reply.code(204).send()
    },
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
