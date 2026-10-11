import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { canAccessLibrary, contentRestrictionAllows, visibleLibraryIds } from './access.js'
import { hashPassword, needsRehash, verifyPassword } from './passwords.js'
import {
  API_KEY_HEADER,
  AUTH_TOKEN_HEADER,
  REMEMBER_ME_COOKIE,
  SESSION_COOKIE,
  registerAuth,
  requireAdmin,
  requireRole,
} from './session.js'
import type { AuthUser } from './types.js'

interface Harness {
  app: FastifyInstance
  database: Database
}

async function setup(): Promise<Harness> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)

  const now = new Date().toISOString()
  await database.db
    .insertInto('users')
    .values([
      {
        id: 'U1',
        email: 'admin@example.com',
        password: hashPassword('admin-pass'),
        roles: JSON.stringify(['ADMIN', 'FILE_DOWNLOAD']),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'U2',
        email: 'kid@example.com',
        password: hashPassword('kid-pass'),
        roles: JSON.stringify(['PAGE_STREAMING']),
        shared_all_libraries: 0,
        age_restriction: 12,
        age_restriction_allow_only: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await database.db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Lib 1', root: '/l1', created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Lib 2', root: '/l2', created_date: now, last_modified_date: now },
    ])
    .execute()

  await database.db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()
  await database.db.insertInto('user_sharing').values({ user_id: 'U2', allow: 0, label: 'mature' }).execute()
  await database.db
    .insertInto('user_api_keys')
    .values({
      id: 'K1',
      user_id: 'U1',
      key: 'the-api-key',
      comment: 'test',
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  const app = Fastify({ logger: { level: 'silent' } })
  await registerAuth(app, { db: database.db })
  app.get('/api/v1/admin-only', { preHandler: requireAdmin }, async () => ({ ok: true }))
  app.get('/api/v1/stream-only', { preHandler: requireRole('PAGE_STREAMING') }, async () => ({ ok: true }))
  await app.ready()

  return { app, database }
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)]
  return list.map((entry) => String(entry).split(';')[0]).join('; ')
}

function cookiesOf(response: { headers: Record<string, unknown> }): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of cookieHeader(response).split('; ')) {
    const [name, ...rest] = part.split('=')
    if (name) result[name] = rest.join('=')
  }
  return result
}

async function login(app: FastifyInstance, email: string, password: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/login',
    headers: { 'content-type': 'application/json' },
    payload: { email, password, ...extra },
  })
}

describe('password hashing', () => {
  it('verifies its own hashes and flags low-cost ones for rehash', () => {
    const strong = hashPassword('secret')
    expect(verifyPassword('secret', strong)).toBe(true)
    expect(verifyPassword('wrong', strong)).toBe(false)
    expect(needsRehash(strong)).toBe(false)
    expect(needsRehash(hashPassword('secret', 10))).toBe(true)
    expect(needsRehash('not-a-hash')).toBe(true)
  })
})

describe('login and sessions', () => {
  it('rejects bad credentials and records the attempt', async () => {
    const { app, database } = await setup()
    const res = await login(app, 'admin@example.com', 'wrong')
    expect(res.statusCode).toBe(401)

    const activity = await database.db.selectFrom('authentication_activity').selectAll().execute()
    expect(activity).toHaveLength(1)
    expect(activity[0]?.success).toBe(0)

    await app.close()
  })

  it('issues a cookie and X-Auth-Token, persists the session, and resumes it', async () => {
    const { app, database } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'admin-pass' },
    })
    expect(res.statusCode).toBe(200)

    const token = res.headers[AUTH_TOKEN_HEADER]
    expect(typeof token).toBe('string')

    const sessions = await database.db.selectFrom('sessions').selectAll().execute()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.user_id).toBe('U1')

    const viaHeader = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { [AUTH_TOKEN_HEADER]: String(token) },
    })
    expect(viaHeader.statusCode).toBe(200)
    expect(viaHeader.json().email).toBe('admin@example.com')
    expect(viaHeader.json().roles).toContain('ADMIN')

    const viaCookie = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader(res) } })
    expect(viaCookie.statusCode).toBe(200)

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(anonymous.statusCode).toBe(401)

    await app.close()
  })

  it('upgrades a legacy low-cost hash on successful login', async () => {
    const { app, database } = await setup()
    await database.db
      .updateTable('users')
      .set({ password: hashPassword('legacy-pass', 8) })
      .where('id', '=', 'U1')
      .execute()

    const res = await login(app, 'admin@example.com', 'legacy-pass')
    expect(res.statusCode).toBe(200)

    const row = await database.db.selectFrom('users').select('password').where('id', '=', 'U1').executeTakeFirst()
    expect(needsRehash(row!.password)).toBe(false)
    expect(verifyPassword('legacy-pass', row!.password)).toBe(true)

    await app.close()
  })

  it('logs out and invalidates the session', async () => {
    const { app, database } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'admin-pass' },
    })
    const token = String(res.headers[AUTH_TOKEN_HEADER])

    const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { [AUTH_TOKEN_HEADER]: token } })
    expect(logout.statusCode).toBe(204)
    expect(await database.db.selectFrom('sessions').selectAll().execute()).toHaveLength(0)

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { [AUTH_TOKEN_HEADER]: token } })
    expect(me.statusCode).toBe(401)

    await app.close()
  })

  it('exchanges an X-Auth-Token session for a cookie', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'admin-pass' },
    })
    const token = String(res.headers[AUTH_TOKEN_HEADER])

    const setCookie = await app.inject({
      method: 'POST',
      url: '/api/v1/login/set-cookie',
      headers: { [AUTH_TOKEN_HEADER]: token },
    })
    expect(setCookie.statusCode).toBe(204)
    expect(String(setCookie.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`)

    await app.close()
  })
})

describe('other auth transports', () => {
  it('authenticates with HTTP Basic', async () => {
    const { app } = await setup()
    const header = `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}`
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: header } })
    expect(res.statusCode).toBe(200)
    expect(res.json().email).toBe('kid@example.com')
    await app.close()
  })

  it('authenticates with an API key', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { [API_KEY_HEADER]: 'the-api-key' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().email).toBe('admin@example.com')

    const bad = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { [API_KEY_HEADER]: 'nope' } })
    expect(bad.statusCode).toBe(401)

    await app.close()
  })

  it('authenticates with a remember-me cookie, and rejects a tampered one', async () => {
    const { app } = await setup()
    const res = await login(app, 'admin@example.com', 'admin-pass', { 'remember-me': true })
    const cookies = cookiesOf(res)
    expect(cookies[REMEMBER_ME_COOKIE]).toBeTruthy()

    const rememberOnly = `${REMEMBER_ME_COOKIE}=${cookies[REMEMBER_ME_COOKIE]}`
    const ok = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: rememberOnly } })
    expect(ok.statusCode).toBe(200)

    const tampered = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${REMEMBER_ME_COOKIE}=U1.99999999999999.deadbeef` },
    })
    expect(tampered.statusCode).toBe(401)

    await app.close()
  })
})

describe('role enforcement', () => {
  it('allows admins and forbids others', async () => {
    const { app } = await setup()
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin-only',
      headers: { [API_KEY_HEADER]: 'the-api-key' },
    })
    expect(admin.statusCode).toBe(200)

    const kid = await app.inject({
      method: 'GET',
      url: '/api/v1/admin-only',
      headers: { authorization: `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}` },
    })
    expect(kid.statusCode).toBe(403)

    const streamer = await app.inject({
      method: 'GET',
      url: '/api/v1/stream-only',
      headers: { authorization: `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}` },
    })
    expect(streamer.statusCode).toBe(200)

    await app.close()
  })
})

describe('access helpers', () => {
  const base: AuthUser = {
    id: 'U',
    email: 'u@example.com',
    roles: [],
    sharedAllLibraries: false,
    sharedLibraryIds: ['L1'],
    restrictions: { ageRestriction: null, labelsAllow: [], labelsExclude: [] },
  }

  it('scopes libraries', () => {
    expect(canAccessLibrary(base, 'L1')).toBe(true)
    expect(canAccessLibrary(base, 'L2')).toBe(false)
    expect(visibleLibraryIds(base, ['L1', 'L2'])).toEqual(['L1'])
    expect(visibleLibraryIds({ ...base, sharedAllLibraries: true }, ['L1', 'L2'])).toEqual(['L1', 'L2'])
    expect(visibleLibraryIds({ ...base, roles: ['ADMIN'] }, ['L1', 'L2'])).toEqual(['L1', 'L2'])
  })

  it('applies age restrictions in ALLOW_ONLY mode', () => {
    const user: AuthUser = {
      ...base,
      restrictions: { ageRestriction: { age: 12, restriction: 'ALLOW_ONLY' }, labelsAllow: [], labelsExclude: [] },
    }
    expect(contentRestrictionAllows(user, { ageRating: 10, sharingLabels: [] })).toBe(true)
    expect(contentRestrictionAllows(user, { ageRating: 18, sharingLabels: [] })).toBe(false)
    // An allow label is an escape hatch for content above the age restriction.
    const withAllow: AuthUser = { ...user, restrictions: { ...user.restrictions, labelsAllow: ['kids'] } }
    expect(contentRestrictionAllows(withAllow, { ageRating: 18, sharingLabels: ['kids'] })).toBe(true)
    expect(contentRestrictionAllows(withAllow, { ageRating: 18, sharingLabels: ['other'] })).toBe(false)
  })

  it('applies excluded labels and age EXCLUDE mode', () => {
    const user: AuthUser = {
      ...base,
      restrictions: { ageRestriction: null, labelsAllow: [], labelsExclude: ['mature'] },
    }
    expect(contentRestrictionAllows(user, { ageRating: null, sharingLabels: ['mature'] })).toBe(false)
    expect(contentRestrictionAllows(user, { ageRating: null, sharingLabels: ['safe'] })).toBe(true)

    const exclude: AuthUser = {
      ...base,
      restrictions: { ageRestriction: { age: 18, restriction: 'EXCLUDE' }, labelsAllow: [], labelsExclude: [] },
    }
    expect(contentRestrictionAllows(exclude, { ageRating: 20, sharingLabels: [] })).toBe(false)
    expect(contentRestrictionAllows(exclude, { ageRating: 5, sharingLabels: [] })).toBe(true)
    expect(contentRestrictionAllows(exclude, { ageRating: null, sharingLabels: [] })).toBe(true)
  })

  it('lets admins see everything', () => {
    const admin: AuthUser = {
      ...base,
      roles: ['ADMIN'],
      restrictions: {
        ageRestriction: { age: 0, restriction: 'ALLOW_ONLY' },
        labelsAllow: [],
        labelsExclude: ['mature'],
      },
    }
    expect(contentRestrictionAllows(admin, { ageRating: 18, sharingLabels: ['mature'] })).toBe(true)
  })
})
