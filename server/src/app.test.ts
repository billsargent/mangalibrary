import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, buildServer } from './app.js'
import { hashPassword } from './auth/passwords.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'

async function buildTestServer() {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-app-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const app = await buildServer({ config, database })
  return { app, database }
}

describe('app', () => {
  it('serves /health', async () => {
    const { app } = await buildTestServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', version: APP_VERSION })
    await app.close()
  })

  it('returns 404 for unknown routes', async () => {
    const { app } = await buildTestServer()
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('authenticates a real user end to end', async () => {
    const { app, database } = await buildTestServer()
    const now = new Date().toISOString()
    await database.db
      .insertInto('users')
      .values({
        id: 'U1',
        email: 'reader@example.com',
        password: hashPassword('reader-pass'),
        roles: JSON.stringify(['PAGE_STREAMING']),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'reader@example.com', password: 'nope' },
    })
    expect(bad.statusCode).toBe(401)

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', 'x-auth-token': '' },
      payload: { email: 'reader@example.com', password: 'reader-pass' },
    })
    expect(login.statusCode).toBe(200)
    const token = String(login.headers['x-auth-token'])

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-auth-token': token } })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('reader@example.com')

    await app.close()
  })
})
