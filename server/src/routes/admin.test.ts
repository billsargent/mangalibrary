import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { REMEMBER_ME_COOKIE } from '../auth/session.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import type { DB } from '../db/schema.js'
import { MAX_UPLOAD_BYTES } from '../uploads.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }
const ADMIN_PASSWORD = 'admin-pass'

interface Fixture {
  app: FastifyInstance
  database: Database
  db: Kysely<DB>
}

/** `claimed` decides whether the server already has users, which is what the claim routes report. */
async function setup(claimed = true): Promise<Fixture> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-admin-config-')),
    LOG_LEVEL: 'silent',
    SERVER_PORT: '25600',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db

  if (claimed) {
    const now = new Date().toISOString()
    await db
      .insertInto('users')
      .values([
        {
          id: 'U1',
          email: 'admin@example.com',
          password: hashPassword(ADMIN_PASSWORD),
          roles: JSON.stringify(['ADMIN']),
          shared_all_libraries: 1,
          age_restriction: null,
          age_restriction_allow_only: null,
          created_date: now,
          last_modified_date: now,
        },
        {
          id: 'U2',
          email: 'reader@example.com',
          password: hashPassword('reader-pass'),
          roles: JSON.stringify(['PAGE_STREAMING', 'FILE_DOWNLOAD']),
          shared_all_libraries: 1,
          age_restriction: null,
          age_restriction_allow_only: null,
          created_date: now,
          last_modified_date: now,
        },
      ])
      .execute()

    await db
      .insertInto('user_api_keys')
      .values([
        { id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now },
        { id: 'K2', user_id: 'U2', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now },
      ])
      .execute()
  }

  return { app: await buildServer({ config, database }), database, db }
}

async function storedSetting(db: Kysely<DB>, key: string): Promise<string | undefined> {
  const row = await db.selectFrom('server_settings').select('value').where('key', '=', key).executeTakeFirst()
  return row?.value
}

describe('server settings', () => {
  it('reports the defaults to an admin', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: admin })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body.deleteEmptyCollections).toBe(false)
    expect(body.deleteEmptyReadLists).toBe(false)
    expect(body.rememberMeDurationDays).toBe(365)
    expect(body.thumbnailSize).toBe('DEFAULT')
    expect(body.taskPoolSize).toBe(1)
    expect(body.maxUploadFileSizeBytes).toBe(MAX_UPLOAD_BYTES)
    // The port came from the configuration, so it is reported as such and is
    // the one in use.
    expect(body.serverPort).toEqual({ configurationSource: 25600, databaseSource: null, effectiveValue: 25600 })
    expect(body.serverContextPath).toEqual({ configurationSource: null, databaseSource: null, effectiveValue: null })
    // The Kobo port is a plain integer in the contract, unlike the ports above: a client
    // binds it to a number field, and an object there is a field full of NaN.
    expect(body.koboPort).toBeNull()

    await app.close()
  })

  it('shows a reader the upload limit and nothing else', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ maxUploadFileSizeBytes: MAX_UPLOAD_BYTES })

    expect((await app.inject({ method: 'GET', url: '/api/v1/settings' })).statusCode).toBe(401)
    await app.close()
  })

  it('stores an update and reports it back', async () => {
    const { app } = await setup()

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: admin,
      payload: {
        deleteEmptyCollections: true,
        rememberMeDurationDays: 30,
        thumbnailSize: 'LARGE',
        taskPoolSize: 2,
        koboPort: 8081,
      },
    })
    expect(res.statusCode).toBe(204)

    const body = (await app.inject({ method: 'GET', url: '/api/v1/settings', headers: admin })).json() as Record<
      string,
      unknown
    >
    expect(body.deleteEmptyCollections).toBe(true)
    expect(body.rememberMeDurationDays).toBe(30)
    expect(body.thumbnailSize).toBe('LARGE')
    expect(body.taskPoolSize).toBe(2)
    expect(body.deleteEmptyReadLists).toBe(false)
    expect(body.koboPort).toBe(8081)

    await app.close()
  })

  it('rejects values it cannot honour', async () => {
    const { app } = await setup()

    for (const payload of [
      { thumbnailSize: 'HUGE' },
      { taskPoolSize: 0 },
      { rememberMeDurationDays: -1 },
      { serverPort: 70000 },
      { serverContextPath: '/komga' },
    ]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: admin, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }

    // Nothing was stored by the rejected updates.
    const body = (await app.inject({ method: 'GET', url: '/api/v1/settings', headers: admin })).json() as Record<
      string,
      unknown
    >
    expect(body.thumbnailSize).toBe('DEFAULT')

    await app.close()
  })

  it('only lets an admin change them', async () => {
    const { app } = await setup()

    expect(
      (await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: reader, payload: { taskPoolSize: 4 } }))
        .statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: { taskPoolSize: 4 } })).statusCode,
    ).toBe(401)

    await app.close()
  })

  it('clears a nullable setting with an explicit null', async () => {
    const { app } = await setup()

    await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: admin, payload: { serverPort: 1234 } })
    let body = (await app.inject({ method: 'GET', url: '/api/v1/settings', headers: admin })).json() as Record<
      string,
      unknown
    >
    expect(body.serverPort).toEqual({ configurationSource: 25600, databaseSource: 1234, effectiveValue: 25600 })

    await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: admin, payload: { serverPort: null } })
    body = (await app.inject({ method: 'GET', url: '/api/v1/settings', headers: admin })).json() as Record<
      string,
      unknown
    >
    expect(body.serverPort).toEqual({ configurationSource: 25600, databaseSource: null, effectiveValue: 25600 })

    await app.close()
  })

  it('renews the remember-me key and invalidates the cookies signed with it', async () => {
    const { app, db } = await setup()

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { email: 'admin@example.com', password: ADMIN_PASSWORD, 'remember-me': true },
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies.find((entry) => entry.name === REMEMBER_ME_COOKIE)
    expect(cookie).toBeDefined()

    const before = await storedSetting(db, 'REMEMBER_ME_KEY')
    expect(before).toBeDefined()

    // The cookie authenticates while the key is the one that signed it.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { [REMEMBER_ME_COOKIE]: cookie!.value } }))
        .statusCode,
    ).toBe(200)

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/settings',
          headers: admin,
          payload: { renewRememberMeKey: true },
        })
      ).statusCode,
    ).toBe(204)

    expect(await storedSetting(db, 'REMEMBER_ME_KEY')).not.toBe(before)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { [REMEMBER_ME_COOKIE]: cookie!.value } }))
        .statusCode,
    ).toBe(401)

    await app.close()
  })

  it('issues remember-me cookies with the configured lifetime', async () => {
    const { app } = await setup()

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: admin,
      payload: { rememberMeDurationDays: 10 },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { email: 'admin@example.com', password: ADMIN_PASSWORD, 'remember-me': true },
    })

    const cookie = login.cookies.find((entry) => entry.name === REMEMBER_ME_COOKIE)
    expect(cookie?.maxAge).toBe(10 * 24 * 60 * 60)

    await app.close()
  })
})

describe('client settings', () => {
  it('stores global settings and hides the private ones from anonymous callers', async () => {
    const { app } = await setup()

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/client-settings/global',
      headers: admin,
      payload: {
        'application.public': { value: 'anyone', allowUnauthorized: true },
        'application.private': { value: 'members', allowUnauthorized: false },
      },
    })
    expect(res.statusCode).toBe(204)

    // No credentials at all: only what the setting says anyone may read.
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/client-settings/global/list' })
    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.json()).toEqual({ 'application.public': { allowUnauthorized: true, value: 'anyone' } })

    const asReader = await app.inject({
      method: 'GET',
      url: '/api/v1/client-settings/global/list',
      headers: reader,
    })
    expect(asReader.json()).toEqual({
      'application.public': { allowUnauthorized: true, value: 'anyone' },
      'application.private': { allowUnauthorized: false, value: 'members' },
    })

    // Overwriting keeps the flag in step with the new value.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/client-settings/global',
      headers: admin,
      payload: { 'application.public': { value: 'changed', allowUnauthorized: false } },
    })
    expect((await app.inject({ method: 'GET', url: '/api/v1/client-settings/global/list' })).json()).toEqual({})

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/client-settings/global',
      headers: admin,
      payload: ['application.public'],
    })
    expect(deleted.statusCode).toBe(204)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/client-settings/global/list', headers: reader })).json(),
    ).toEqual({ 'application.private': { allowUnauthorized: false, value: 'members' } })

    await app.close()
  })

  it('refuses global writes from a reader and malformed keys from anyone', async () => {
    const { app } = await setup()

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/client-settings/global',
          headers: reader,
          payload: { 'application.key': { value: 'x', allowUnauthorized: false } },
        })
      ).statusCode,
    ).toBe(403)

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/client-settings/global',
          headers: admin,
          payload: { 'Not A Key': { value: 'x', allowUnauthorized: false } },
        })
      ).statusCode,
    ).toBe(400)

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/client-settings/user',
          headers: reader,
          payload: { 'Not A Key': { value: 'x' } },
        })
      ).statusCode,
    ).toBe(400)

    await app.close()
  })

  it('keeps user settings to the user who wrote them', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/client-settings/user/list' })).statusCode).toBe(401)

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/client-settings/user',
      headers: reader,
      payload: { 'ui.theme': { value: 'dark' }, 'ui.zoom': { value: '1.5' } },
    })

    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/client-settings/user/list', headers: reader })).json(),
    ).toEqual({
      'ui.theme': { allowUnauthorized: false, value: 'dark' },
      'ui.zoom': { allowUnauthorized: false, value: '1.5' },
    })
    // The admin's own list is a different list.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/client-settings/user/list', headers: admin })).json(),
    ).toEqual({})

    await app.inject({
      method: 'DELETE',
      url: '/api/v1/client-settings/user',
      headers: reader,
      payload: ['ui.theme'],
    })
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/client-settings/user/list', headers: reader })).json(),
    ).toEqual({ 'ui.zoom': { allowUnauthorized: false, value: '1.5' } })

    await app.close()
  })
})

describe('claim', () => {
  it('reports an unclaimed server and creates the first admin', async () => {
    const { app } = await setup(false)

    expect((await app.inject({ method: 'GET', url: '/api/v1/claim' })).json()).toEqual({ isClaimed: false })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/claim',
      headers: { 'x-komga-email': 'founder@example.com', 'x-komga-password': 'a-good-password' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { email: string; roles: string[] }
    expect(body.email).toBe('founder@example.com')
    expect(body.roles).toContain('ADMIN')

    expect((await app.inject({ method: 'GET', url: '/api/v1/claim' })).json()).toEqual({ isClaimed: true })

    // The new admin can sign in, and the server cannot be claimed twice.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { email: 'founder@example.com', password: 'a-good-password' },
    })
    expect(login.statusCode).toBe(200)

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/claim',
      headers: { 'x-komga-email': 'someone@example.com', 'x-komga-password': 'another-password' },
    })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toEqual({ message: 'This server has already been claimed' })

    await app.close()
  })

  it('refuses a malformed email or a blank password', async () => {
    const { app } = await setup(false)

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/claim',
      headers: { 'x-komga-email': 'not-an-email', 'x-komga-password': 'a-good-password' },
    })
    expect(badEmail.statusCode).toBe(400)

    const blankPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/claim',
      headers: { 'x-komga-email': 'founder@example.com', 'x-komga-password': '   ' },
    })
    expect(blankPassword.statusCode).toBe(400)

    expect((await app.inject({ method: 'GET', url: '/api/v1/claim' })).json()).toEqual({ isClaimed: false })
    await app.close()
  })
})

describe('actuator', () => {
  it('reports the version and the runtime', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/actuator/info' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { build: { version: string }; runtime: { name: string; version: string } }
    expect(body.build.version).toBeTruthy()
    expect(body.runtime.name).toBe('Node.js')
    expect(body.runtime.version).toBe(process.version)

    await app.close()
  })
})
