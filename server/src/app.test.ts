import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, buildServer } from './app.js'
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
  return buildServer({ config, database })
}

describe('app', () => {
  it('serves /health', async () => {
    const app = await buildTestServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', version: APP_VERSION })
    await app.close()
  })

  it('returns 404 for unknown routes', async () => {
    const app = await buildTestServer()
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
