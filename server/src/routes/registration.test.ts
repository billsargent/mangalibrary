import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { verifyPassword } from '../auth/passwords.js'
import { hashPassword } from '../auth/passwords.js'
import { RateLimiter } from '../auth/rate-limit.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { SETTING_KEYS, setSetting } from '../settings.js'
import { REGISTRATION_EMAIL_LIMIT } from './registration.js'

const ADMIN_KEY = 'admin-key'
const admin = { 'x-api-key': ADMIN_KEY }

/**
 * A server with an admin, so it counts as claimed, and with `users` deciding whether
 * anybody is there at all - which is what makes it unclaimed.
 */
async function setup(claimed = true): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-register-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  if (claimed) {
    await database.db
      .insertInto('users')
      .values({
        id: 'U1',
        email: 'admin@example.com',
        password: hashPassword('admin-pass'),
        roles: JSON.stringify(['ADMIN']),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await database.db
      .insertInto('user_api_keys')
      .values({ id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now })
      .execute()
  }

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

/** Turn registration on through the admin route. */
async function open(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/registration',
    headers: admin,
    payload: { enabled: true },
  })
  expect(res.statusCode).toBe(204)
}

/** Register an account, returning the response. */
async function register(app: FastifyInstance, email: string, password: string) {
  return await app.inject({ method: 'POST', url: '/api/v1/registration', payload: { email, password } })
}

/** The stored user with an email, or undefined. */
async function user(database: Database, email: string) {
  return database.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst()
}

describe('registration', () => {
  it('is closed by default, and says so', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/registration' })).json()).toEqual({
      enabled: false,
      defaultRoles: ['PAGE_STREAMING', 'FILE_DOWNLOAD'],
    })

    const res = await register(app, 'new@example.com', 'a-password')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ message: 'Registration is not open' })
    await app.close()
  })

  it('refuses while the server is unclaimed, even when it is open', async () => {
    const { app, database } = await setup(false)
    // Set directly: turning it on needs an admin, and there is none yet.
    await setSetting(database.db, SETTING_KEYS.registration, 'OPEN')

    const res = await register(app, 'first@example.com', 'a-password')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ message: 'This server has not been claimed yet' })
    expect(await user(database, 'first@example.com')).toBeUndefined()
    await app.close()
  })

  it('creates a usable account, without signing it in', async () => {
    const { app, database } = await setup()
    await open(app)

    const res = await register(app, 'New@Example.com', 'a-password')
    expect(res.statusCode).toBe(204)

    const created = await user(database, 'New@Example.com')
    expect(created).toBeDefined()
    // The password is stored hashed, like any other account's.
    expect(verifyPassword('a-password', created!.password)).toBe(true)
    expect(verifyPassword('another-password', created!.password)).toBe(false)
    expect(JSON.parse(created!.roles)).toEqual(['PAGE_STREAMING', 'FILE_DOWNLOAD'])
    // Nothing is shared until an admin shares it.
    expect(created!.shared_all_libraries).toBe(0)

    // No session was handed out: the account still has to sign in.
    expect(res.headers['set-cookie']).toBeUndefined()
    const sessions = await database.db.selectFrom('sessions').selectAll().execute()
    expect(sessions).toEqual([])

    // And the event is in the authentication log, as a success.
    const activity = await database.db
      .selectFrom('authentication_activity')
      .selectAll()
      .where('email', '=', 'New@Example.com')
      .execute()
    expect(activity).toHaveLength(1)
    expect(activity[0]!.success).toBe(1)
    expect(activity[0]!.user_id).toBe(created!.id)

    // Signing in works.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { email: 'New@Example.com', password: 'a-password' },
    })
    expect(signIn.statusCode).toBe(200)
    await app.close()
  })

  it('refuses an address that is already registered, and an invalid one', async () => {
    const { app, database } = await setup()
    await open(app)

    expect((await register(app, 'admin@example.com', 'a-password')).statusCode).toBe(400)
    expect((await register(app, 'admin@example.com', 'a-password')).json()).toEqual({
      message: 'email already in use',
    })
    expect((await register(app, 'not-an-address', 'a-password')).json()).toEqual({
      message: 'email must be a valid email address',
    })
    expect((await register(app, 'new@example.com', '')).json()).toEqual({ message: 'password must not be blank' })

    // The refusals are in the log too, and no account was made.
    const activity = await database.db.selectFrom('authentication_activity').selectAll().execute()
    expect(activity.every((row) => row.success === 0)).toBe(true)
    expect(activity.length).toBeGreaterThanOrEqual(4)
    await app.close()
  })

  it('rate limits repeated attempts, then lets them through again', async () => {
    const { app } = await setup()
    await open(app)

    // One address, tried over and over: the first attempt works and the rest are
    // refused because it is taken, but every one of them counts.
    expect((await register(app, 'taken@example.com', 'a-password')).statusCode).toBe(204)
    for (let attempt = 1; attempt < REGISTRATION_EMAIL_LIMIT; attempt += 1) {
      expect((await register(app, 'taken@example.com', 'a-password')).statusCode, `attempt ${attempt}`).toBe(400)
    }

    const refused = await register(app, 'taken@example.com', 'a-password')
    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toEqual({ message: 'Too many registration attempts, try again later' })

    // A different address from the same caller is still free to try.
    expect((await register(app, 'another@example.com', 'a-password')).statusCode).toBe(204)
    await app.close()
  })

  it('rate limits one caller trying many addresses', { timeout: 30_000 }, async () => {
    const { app } = await setup()
    await open(app)

    // Three addresses, four attempts each: every address stays under its own budget,
    // so what refuses the eleventh attempt is the caller's.
    const attempts: number[] = []
    for (const address of ['a@example.com', 'b@example.com', 'c@example.com']) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const res = await register(app, address, 'a-password')
        attempts.push(res.statusCode)
      }
    }

    expect(attempts.slice(0, 10).every((status) => status === 204 || status === 400)).toBe(true)
    expect(attempts.slice(10)).toEqual([429, 429])
    await app.close()
  })

  it('hands out the roles the server is set to, and never ADMIN', async () => {
    const { app, database } = await setup()

    const set = await app.inject({
      method: 'PUT',
      url: '/api/v1/registration',
      headers: admin,
      payload: { enabled: true, defaultRoles: ['PAGE_STREAMING'] },
    })
    expect(set.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v1/registration' })).json()).toEqual({
      enabled: true,
      defaultRoles: ['PAGE_STREAMING'],
    })

    await register(app, 'reader@example.com', 'a-password')
    expect(JSON.parse((await user(database, 'reader@example.com'))!.roles)).toEqual(['PAGE_STREAMING'])

    // An admin cannot hand out the role that administers, by setting or by hand.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/registration',
          headers: admin,
          payload: { defaultRoles: ['ADMIN'] },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/registration',
          headers: admin,
          payload: { defaultRoles: ['PAGE_STREAMING', 'NOT_A_ROLE'] },
        })
      ).statusCode,
    ).toBe(400)

    await database.db
      .insertInto('server_settings')
      .values({ key: 'REGISTRATION_DEFAULT_ROLES', value: 'ADMIN,PAGE_STREAMING' })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: 'ADMIN,PAGE_STREAMING' }))
      .execute()
    expect((await app.inject({ method: 'GET', url: '/api/v1/registration' })).json()).toEqual({
      enabled: true,
      defaultRoles: ['PAGE_STREAMING'],
    })

    await app.close()
  })

  it('needs an admin to open it, and closes again when told to', async () => {
    const { app } = await setup()

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/registration',
          headers: { 'x-api-key': 'not-a-key' },
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(401)

    await open(app)
    expect((await app.inject({ method: 'GET', url: '/api/v1/registration' })).json()).toMatchObject({ enabled: true })

    const close = await app.inject({
      method: 'PUT',
      url: '/api/v1/registration',
      headers: admin,
      payload: { enabled: false },
    })
    expect(close.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v1/registration' })).json()).toMatchObject({ enabled: false })
    await app.close()
  })

  it('refuses a body it cannot understand', async () => {
    const { app } = await setup()
    await open(app)

    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/registration', headers: admin, payload: { enabled: 'yes' } }))
        .statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/registration',
          headers: admin,
          payload: { defaultRoles: 'ADMIN' },
        })
      ).statusCode,
    ).toBe(400)
    await app.close()
  })
})

describe('the rate limiter', () => {
  it('counts attempts over a sliding window, and forgets them after it', () => {
    let now = 1_000
    const limiter = new RateLimiter({ limit: 2, windowMs: 100, now: () => now })

    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    // Another key is unaffected.
    expect(limiter.allow('b')).toBe(true)

    now += 101
    expect(limiter.allow('a')).toBe(true)
  })
})
