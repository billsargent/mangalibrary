import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

const PAGE = '<!doctype html><html><body><div id="app"></div></body></html>'

/** A bundle the way Vite leaves one: the page, hashed assets beside it, a favicon. */
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ui-bundle-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), PAGE)
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("app")')
  writeFileSync(join(dir, 'favicon.ico'), 'icon')
  return dir
}

async function setup(uiDir?: string): Promise<FastifyInstance> {
  const env: Record<string, string> = {
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-ui-config-')),
    LOG_LEVEL: 'silent',
  }
  if (uiDir !== undefined) env.KOMGA_UI_DIR = uiDir

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const app = await buildServer({ config: loadConfig(env as NodeJS.ProcessEnv), database })
  await app.ready()
  return app
}

describe('serving the web UI', () => {
  it('serves the page at the root, to be asked for again every time', async () => {
    const app = await setup(bundle())

    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toBe(PAGE)

    await app.close()
  })

  it('serves a hashed asset as a file that never changes, and the rest for a while', async () => {
    const app = await setup(bundle())

    const script = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(script.statusCode).toBe(200)
    expect(script.headers['content-type']).toContain('javascript')
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const icon = await app.inject({ method: 'GET', url: '/favicon.ico' })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['cache-control']).toBe('public, max-age=3600')

    await app.close()
  })

  it.each(['/login', '/libraries/all/series', '/series/0ABC', '/book/0ABC/read?page=3', '/book/0ABC/read-epub'])(
    'answers %s, a route inside the application, with the page',
    async (url) => {
      const app = await setup(bundle())

      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.body).toBe(PAGE)

      await app.close()
    },
  )

  it.each(['/api/v1/nothing-here', '/api', '/sse/v1/nothing', '/actuator/nothing', '/opds/v1.2/catalog'])(
    'answers %s, an API path this server does not have, with a JSON 404 and not the page',
    async (url) => {
      const app = await setup(bundle())

      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' })

      await app.close()
    },
  )

  it('does not answer a missing file, or anything but a read, with the page', async () => {
    const app = await setup(bundle())

    expect((await app.inject({ method: 'GET', url: '/assets/gone-000.js' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/apple-touch-icon.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(404)

    await app.close()
  })

  it('does not let a path climb out of the bundle', async () => {
    const dir = bundle()
    writeFileSync(join(dir, '..', 'ml-ui-secret.txt'), 'outside the bundle')
    const app = await setup(dir)

    for (const url of ['/../ml-ui-secret.txt', '/assets/../../ml-ui-secret.txt', '/%2e%2e/ml-ui-secret.txt']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body, url).not.toContain('outside the bundle')
    }

    await app.close()
  })

  it('leaves the API and the health check as they were', async () => {
    const app = await setup(bundle())

    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ status: 'ok' })

    expect((await app.inject({ method: 'GET', url: '/actuator/info' })).statusCode).toBe(200)
    // An endpoint that needs a user still says so, rather than showing the page.
    expect((await app.inject({ method: 'GET', url: '/api/v1/libraries' })).statusCode).toBe(401)

    await app.close()
  })
})

describe('a server with no web UI', () => {
  it.each([undefined, join(tmpdir(), 'ml-ui-not-a-bundle')])(
    'answers as it always has when the bundle is %s',
    async (uiDir) => {
      const app = await setup(uiDir)

      const root = await app.inject({ method: 'GET', url: '/' })
      expect(root.statusCode).toBe(404)
      expect(root.json()).toEqual({ message: 'Route GET:/ not found', error: 'Not Found', statusCode: 404 })

      expect((await app.inject({ method: 'GET', url: '/series/0ABC' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)

      await app.close()
    },
  )
})
