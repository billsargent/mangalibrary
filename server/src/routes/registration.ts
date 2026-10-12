/**
 * Self-service signup.
 *
 * An extension rather than part of the port: Komga has no registration, and every
 * account is made by an admin. A client that knows nothing about these routes is
 * unaffected by them - they are new paths, and the default is closed.
 *
 * Three rules keep opening it from being a mistake. It is off until an admin turns it
 * on (`GET`/`PUT /api/v1/registration`). It is refused while the server is unclaimed,
 * so the first visitor to a fresh instance cannot register instead of claiming, which
 * would leave the instance with a stranger holding the only account. And a new account
 * is given the roles the server is configured to hand out, which can never include
 * `ADMIN`, is never signed in automatically, and shares no library until an admin says
 * so.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'

import { hashPassword } from '../auth/passwords.js'
import { RateLimiter } from '../auth/rate-limit.js'
import { recordActivity, requireAdmin } from '../auth/session.js'
import { USER_ROLES, isUserRole, type UserRole } from '../auth/types.js'
import type { DB } from '../db/schema.js'
import { SETTING_KEYS, getStringSetting, setSetting } from '../settings.js'
import { nextTsid } from '../tsid.js'
import type { RouteOptions } from './libraries.js'

/** The email shape the rest of the server accepts. */
const EMAIL = /.+@.+\..+/

/** Whether registration is open. Closed unless an admin says otherwise. */
export type RegistrationMode = 'CLOSED' | 'OPEN'

/** The roles a new account is given when nothing else is configured. */
export const DEFAULT_REGISTRATION_ROLES: UserRole[] = ['PAGE_STREAMING', 'FILE_DOWNLOAD']

/** How many attempts may be made, and over how long. */
export const REGISTRATION_EMAIL_LIMIT = 5
export const REGISTRATION_ADDRESS_LIMIT = 10
export const REGISTRATION_WINDOW_MS = 15 * 60 * 1000

/** The mode the server is set to, falling back to closed. */
export async function registrationMode(db: Kysely<DB>): Promise<RegistrationMode> {
  const stored = await getStringSetting(db, SETTING_KEYS.registration, 'CLOSED')
  return stored === 'OPEN' ? 'OPEN' : 'CLOSED'
}

/**
 * The roles a new account is given.
 *
 * `ADMIN` is dropped wherever it turns up - including from a setting written by hand
 * - because a role that can administer the server must never be handed out by an
 * endpoint anyone can reach.
 */
export async function registrationRoles(db: Kysely<DB>): Promise<UserRole[]> {
  const stored = await getStringSetting(db, SETTING_KEYS.registrationDefaultRoles, DEFAULT_REGISTRATION_ROLES.join(','))
  const roles = stored
    .split(',')
    .map((role) => role.trim().toUpperCase())
    .filter(isUserRole)
    .filter((role) => role !== 'ADMIN')

  return [...new Set(roles)]
}

/** The roles a setting may name: every role except the one that administers. */
export function assignableRoles(value: unknown): UserRole[] | null {
  if (!Array.isArray(value)) return null
  const roles: UserRole[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const role = entry.trim().toUpperCase()
    if (role === 'ADMIN' || !isUserRole(role)) return null
    roles.push(role)
  }
  return [...new Set(roles)]
}

export async function registerRegistrationRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  // Two budgets: one address trying many times is one network; one address being
  // tried many times is one account being probed. A success does not forgive either,
  // because it is the number of attempts that matters, not their outcome.
  const byEmail = new RateLimiter({ limit: REGISTRATION_EMAIL_LIMIT, windowMs: REGISTRATION_WINDOW_MS })
  const byAddress = new RateLimiter({ limit: REGISTRATION_ADDRESS_LIMIT, windowMs: REGISTRATION_WINDOW_MS })

  const userCount = async (): Promise<number> => (await db.selectFrom('users').select('id').execute()).length

  /** What a client needs to know before showing a sign-up form. */
  app.get('/api/v1/registration', async () => ({
    enabled: (await registrationMode(db)) === 'OPEN',
    defaultRoles: await registrationRoles(db),
  }))

  app.post('/api/v1/registration', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    const limited =
      !byAddress.allow(`address\u0000${req.ip ?? 'unknown'}`) || !byEmail.allow(`email\u0000${email.toLowerCase()}`)
    if (limited) {
      await recordActivity(db, null, email === '' ? null : email, req, false, 'Too many registration attempts')
      return reply.code(429).send({ message: 'Too many registration attempts, try again later' })
    }

    if ((await registrationMode(db)) !== 'OPEN') {
      await recordActivity(db, null, email === '' ? null : email, req, false, 'Registration is not open')
      return reply.code(403).send({ message: 'Registration is not open' })
    }

    // An unclaimed server has no users at all, and its first account is what claiming
    // is for. Registering one here would hand the instance to whoever found it first.
    if ((await userCount()) === 0) {
      await recordActivity(db, null, email === '' ? null : email, req, false, 'This server has not been claimed yet')
      return reply.code(403).send({ message: 'This server has not been claimed yet' })
    }

    if (!EMAIL.test(email)) {
      await recordActivity(db, null, email === '' ? null : email, req, false, 'Invalid email address')
      return reply.code(400).send({ message: 'email must be a valid email address' })
    }
    if (password.trim() === '') {
      await recordActivity(db, null, email, req, false, 'Blank password')
      return reply.code(400).send({ message: 'password must not be blank' })
    }

    const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
    if (existing) {
      // Saying so leaks that the address is registered, which is the trade the issue
      // accepts: without it the person cannot tell what went wrong at all.
      await recordActivity(db, null, email, req, false, 'email already in use')
      return reply.code(400).send({ message: 'email already in use' })
    }

    const now = new Date().toISOString()
    const id = nextTsid()
    try {
      await db
        .insertInto('users')
        .values({
          id,
          email,
          password: hashPassword(password),
          roles: JSON.stringify(await registrationRoles(db)),
          // Nothing is shared until an admin shares it, exactly as an admin-created
          // account starts with no libraries.
          shared_all_libraries: 0,
          age_restriction: null,
          age_restriction_allow_only: null,
          created_date: now,
          last_modified_date: now,
        })
        .execute()
    } catch {
      // The unique index is the real guard: two registrations for one address can
      // pass the check above at the same time.
      await recordActivity(db, null, email, req, false, 'email already in use')
      return reply.code(400).send({ message: 'email already in use' })
    }

    await recordActivity(db, id, email, req, true, null)
    // No session: registering is not signing in, and the new account has to prove it
    // can sign in like any other.
    return reply.code(204).send()
  })

  /** Turn registration on or off, and decide what a new account may do. */
  app.put('/api/v1/registration', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>

    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ message: 'enabled must be true or false' })
      }
      await setSetting(db, SETTING_KEYS.registration, body.enabled ? 'OPEN' : 'CLOSED')
    }

    if ('defaultRoles' in body) {
      const roles = assignableRoles(body.defaultRoles)
      if (roles === null) {
        return reply.code(400).send({
          message: `defaultRoles must be an array of role names, from ${USER_ROLES.filter((role) => role !== 'ADMIN').join(', ')}`,
        })
      }
      await setSetting(db, SETTING_KEYS.registrationDefaultRoles, roles.join(','))
    }

    return reply.code(204).send()
  })
}
