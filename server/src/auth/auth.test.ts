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

  it('gives a browser that signs in with Basic a session to keep', async () => {
    const { app, database } = await setup()
    const header = `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}`

    // This is how the forked UI signs in: credentials once, on the current-user call,
    // with the header that says a browser is asking.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: { authorization: header, 'x-requested-with': 'XMLHttpRequest' },
    })
    expect(res.statusCode).toBe(200)

    const session = cookiesOf(res)[SESSION_COOKIE]
    expect(session).toBeTruthy()
    expect(cookiesOf(res)[REMEMBER_ME_COOKIE]).toBeUndefined()

    // And what follows carries only that cookie.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('kid@example.com')

    // The sign-in is in the activity log, as the reference records one.
    const activity = await database.db
      .selectFrom('authentication_activity')
      .selectAll()
      .where('user_id', '=', 'U2')
      .execute()
    expect(activity).toHaveLength(1)
    expect(activity[0]!.success).toBe(1)

    await database.close()
    await app.close()
  })

  it('replaces a session cookie the server cannot resolve, instead of signing in behind it', async () => {
    const { app, database } = await setup()
    const header = `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}`

    // What a browser holds after the session it was given has been purged, or after the
    // server's database was recreated: a cookie naming a session nobody has.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: {
        authorization: header,
        'x-requested-with': 'XMLHttpRequest',
        cookie: `${SESSION_COOKIE}=0123456789abcdef`,
      },
    })

    expect(res.statusCode).toBe(200)
    const issued = cookiesOf(res)[SESSION_COOKIE]
    expect(issued).toBeTruthy()
    expect(issued).not.toBe('0123456789abcdef')

    // The browser is signed in for everything that follows, which is the whole point of
    // issuing the cookie: a sign-in that leaves the browser holding a cookie the server
    // does not know bounces straight back to the login page.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${issued}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('kid@example.com')

    await database.close()
    await app.close()
  })

  it('replaces an expired session cookie and signs in behind a session of another account', async () => {
    const { app, database } = await setup()
    const kid = `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}`
    const admin = `Basic ${Buffer.from('admin@example.com:admin-pass').toString('base64')}`

    const signedIn = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: { authorization: kid, 'x-requested-with': 'XMLHttpRequest' },
    })
    const kidSession = cookiesOf(signedIn)[SESSION_COOKIE]!

    // The same account keeps the session it has: nothing to replace, nothing to issue.
    const sameAccount = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: { authorization: kid, 'x-requested-with': 'XMLHttpRequest', cookie: `${SESSION_COOKIE}=${kidSession}` },
    })
    expect(sameAccount.statusCode).toBe(200)
    expect(cookiesOf(sameAccount)[SESSION_COOKIE]).toBeUndefined()

    // Signing in as somebody else in the same browser hands it the new account's session
    // and takes the old one away with it.
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: {
        authorization: admin,
        'x-requested-with': 'XMLHttpRequest',
        cookie: `${SESSION_COOKIE}=${kidSession}`,
      },
    })
    const adminSession = cookiesOf(other)[SESSION_COOKIE]
    expect(adminSession).toBeTruthy()
    expect(adminSession).not.toBe(kidSession)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${SESSION_COOKIE}=${kidSession}` } }))
        .statusCode,
    ).toBe(401)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${SESSION_COOKIE}=${adminSession}` },
    })
    expect(me.json().email).toBe('admin@example.com')

    // An expired session is no more use to a browser than an unknown one.
    await database.db
      .insertInto('sessions')
      .values({
        id: 'expired-session-id',
        user_id: 'U1',
        data: '{}',
        expires_at: Date.now() - 1000,
        created_date: new Date().toISOString(),
      })
      .execute()
    const expired = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=false',
      headers: {
        authorization: kid,
        'x-requested-with': 'XMLHttpRequest',
        cookie: `${SESSION_COOKIE}=expired-session-id`,
      },
    })
    expect(expired.statusCode).toBe(200)
    const renewed = cookiesOf(expired)[SESSION_COOKIE]
    expect(renewed).toBeTruthy()
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${SESSION_COOKIE}=${renewed}` } }))
        .statusCode,
    ).toBe(200)

    await database.close()
    await app.close()
  })

  it('gives a browser that asks to be remembered both cookies, and no session to a script', async () => {
    const { app, database } = await setup()
    const header = `Basic ${Buffer.from('kid@example.com:kid-pass').toString('base64')}`

    const remembered = await app.inject({
      method: 'GET',
      url: '/api/v1/me?remember-me=true',
      headers: { authorization: header, 'x-requested-with': 'XMLHttpRequest' },
    })
    expect(cookiesOf(remembered)[SESSION_COOKIE]).toBeTruthy()
    expect(cookiesOf(remembered)[REMEMBER_ME_COOKIE]).toBeTruthy()

    // A caller that is not a browser - a script, a device - sends its credentials on
    // every request and is left without a session to accumulate.
    const script = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: header } })
    expect(script.statusCode).toBe(200)
    expect(cookiesOf(script)[SESSION_COOKIE]).toBeUndefined()

    // A browser that already has a session is not given a second one either.
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        authorization: header,
        'x-requested-with': 'XMLHttpRequest',
        cookie: `${SESSION_COOKIE}=${cookiesOf(remembered)[SESSION_COOKIE]}`,
      },
    })
    expect(cookiesOf(again)[SESSION_COOKIE]).toBeUndefined()

    await database.close()
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
