import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

const admin = { 'x-api-key': 'admin-key' }

interface Fixture {
  app: FastifyInstance
  database: Database
  fontsDir: string
}

/**
 * A fonts directory as an operator lays one out: one directory per family, the
 * faces inside it, and entries that are not fonts to be left alone.
 */
async function setup(withFonts = true): Promise<Fixture> {
  const configDir = mkdtempSync(join(tmpdir(), 'ml-fonts-config-'))
  const fontsDir = join(configDir, 'fonts')

  if (withFonts) {
    mkdirSync(join(fontsDir, 'Inter'), { recursive: true })
    writeFileSync(join(fontsDir, 'Inter', 'Inter-Regular.woff2'), 'regular bytes')
    writeFileSync(join(fontsDir, 'Inter', 'Inter-Bold.woff2'), 'bold bytes')
    writeFileSync(join(fontsDir, 'Inter', 'Inter-Italic.ttf'), 'italic bytes')
    writeFileSync(join(fontsDir, 'Inter', 'notes.txt'), 'not a font')
    // A family with no font file in it, and a file that is not a family.
    mkdirSync(join(fontsDir, 'Empty'), { recursive: true })
    writeFileSync(join(fontsDir, 'loose.woff'), 'not a family')
  }

  const config = loadConfig({ KOMGA_CONFIG_DIR: configDir, LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv)
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

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
    .values({ id: 'K1', user_id: 'U1', key: 'admin-key', comment: 'admin', created_date: now, last_modified_date: now })
    .execute()

  return { app: await buildServer({ config, database }), database, fontsDir }
}

describe('font families', () => {
  it('lists the directories that hold a font, in order', { timeout: 30_000 }, async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/fonts/families' })).statusCode).toBe(401)

    const res = await app.inject({ method: 'GET', url: '/api/v1/fonts/families', headers: admin })
    expect(res.statusCode).toBe(200)
    // The empty directory is not a family, and neither is a file.
    expect(res.json()).toEqual(['Inter'])

    await app.close()
  })

  it('answers with nothing when no fonts have been added', async () => {
    const { app } = await setup(false)

    const res = await app.inject({ method: 'GET', url: '/api/v1/fonts/families', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])

    await app.close()
  })
})

describe('font files', () => {
  it('serves a face without credentials, because a reader loads it from inside a book', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/Inter-Regular.woff2' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('font/woff2')
    expect(res.headers['content-disposition']).toBe('attachment; filename="Inter-Regular.woff2"')
    expect(res.body).toBe('regular bytes')

    await app.close()
  })

  it('refuses what is not a font of that family', async () => {
    const { app } = await setup()

    // Not a member of the family.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/Inter-Missing.woff2' })).statusCode,
    ).toBe(404)
    // A member, but not a font.
    expect((await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/notes.txt' })).statusCode).toBe(404)
    // Not a family.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Arial/Inter-Regular.woff2' })).statusCode,
    ).toBe(404)
    // An empty family.
    expect((await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Empty/anything.woff' })).statusCode).toBe(
      404,
    )
    // Nothing that tries to climb out of the fonts directory.
    expect((await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/..' })).statusCode).toBe(404)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/..%2F..%2Fconfig.json' })).statusCode,
    ).toBe(404)

    await app.close()
  })
})

describe('font css', () => {
  it('describes each face of the family, with its weight and style', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Inter/css' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/css')
    expect(res.headers['content-disposition']).toBe('attachment; filename="Inter.css"')

    const css = res.body
    // Three faces: the plain one, the bold one and the italic one.
    expect(css.match(/@font-face/g)).toHaveLength(3)
    expect(css).toContain("font-family: 'Inter';")
    expect(css).toContain("url('Inter-Regular.woff2') format('woff2')")
    expect(css).toContain("url('Inter-Italic.ttf') format('truetype')")

    // The characteristics come from the file name, as the reference reads them.
    const bold = /@font-face \{[^}]*Inter-Bold[^}]*\}/.exec(css)?.[0] ?? ''
    expect(bold).toContain('font-weight: bold;')
    expect(bold).toContain('font-style: normal;')

    const italic = /@font-face \{[^}]*Inter-Italic[^}]*\}/.exec(css)?.[0] ?? ''
    expect(italic).toContain('font-weight: normal;')
    expect(italic).toContain('font-style: italic;')

    expect((await app.inject({ method: 'GET', url: '/api/v1/fonts/resource/Missing/css' })).statusCode).toBe(404)

    await app.close()
  })
})
