import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import type { DB } from '../db/schema.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

interface Fixture {
  app: FastifyInstance
  database: Database
  db: Kysely<DB>
}

async function setup(): Promise<Fixture> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-maintenance-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db
  const now = new Date().toISOString()

  await db
    .insertInto('users')
    .values([
      {
        id: 'U1',
        email: 'admin@example.com',
        password: hashPassword('admin-pass'),
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
        roles: JSON.stringify(['PAGE_STREAMING']),
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

  return { app: await buildServer({ config, database }), database, db }
}

describe('history', () => {
  it('lists events newest first and pages through them', async () => {
    const { app, db } = await setup()

    await db
      .insertInto('historical_events')
      .values([
        {
          id: 'E1',
          type: 'BOOK_IMPORTED',
          book_id: 'B1',
          series_id: 'S1',
          properties: JSON.stringify({ file: 'a.cbz' }),
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'E2',
          type: 'BOOK_FILE_DELETED',
          book_id: null,
          series_id: 'S1',
          properties: '{}',
          timestamp: '2024-03-01T00:00:00Z',
        },
        {
          id: 'E3',
          type: 'SERIES_FOLDER_DELETED',
          book_id: null,
          series_id: null,
          properties: '{}',
          timestamp: '2024-02-01T00:00:00Z',
        },
      ])
      .execute()

    const res = await app.inject({ method: 'GET', url: '/api/v1/history', headers: admin })
    expect(res.statusCode).toBe(200)
    const page = res.json() as {
      content: Record<string, unknown>[]
      totalElements: number
      number: number
      size: number
    }

    expect(page.totalElements).toBe(3)
    expect(page.content.map((event) => event.id)).toEqual(['E2', 'E3', 'E1'])
    // A null series or book is left out rather than sent as null.
    expect(page.content[1]).toEqual({
      id: 'E3',
      type: 'SERIES_FOLDER_DELETED',
      timestamp: '2024-02-01T00:00:00Z',
      properties: {},
    })
    expect(page.content[0]?.seriesId).toBe('S1')

    const second = await app.inject({ method: 'GET', url: '/api/v1/history?page=1&size=2', headers: admin })
    const secondPage = second.json() as { content: Record<string, unknown>[]; number: number; totalElements: number }
    expect(secondPage.number).toBe(1)
    expect(secondPage.totalElements).toBe(3)
    expect(secondPage.content.map((event) => event.id)).toEqual(['E1'])

    const ascending = await app.inject({ method: 'GET', url: '/api/v1/history?sort=timestamp,asc', headers: admin })
    expect((ascending.json() as { content: Record<string, unknown>[] }).content.map((event) => event.id)).toEqual([
      'E1',
      'E3',
      'E2',
    ])

    await app.close()
  })

  it('is for admins', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/history', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/history' })).statusCode).toBe(401)

    await app.close()
  })
})

describe('task queue', () => {
  it('clears the queue and reports how much it removed', async () => {
    const { app, db } = await setup()
    const now = new Date().toISOString()

    await db
      .insertInto('jobs')
      .values([
        {
          id: 'J1',
          type: 'ScanLibrary',
          priority: 4,
          group_id: null,
          unique_key: 'scan-1',
          payload: '{}',
          owner: null,
          attempts: 0,
          created_date: now,
          last_modified_date: now,
        },
        {
          id: 'J2',
          type: 'ScanLibrary',
          priority: 4,
          group_id: null,
          unique_key: 'scan-2',
          payload: '{}',
          owner: null,
          attempts: 0,
          created_date: now,
          last_modified_date: now,
        },
      ])
      .execute()

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/tasks', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBe(2)

    expect(await db.selectFrom('jobs').select('id').execute()).toEqual([])

    // A second call removes nothing, and answers zero.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/tasks', headers: admin })).json()).toBe(0)

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/tasks', headers: reader })).statusCode).toBe(403)
    await app.close()
  })
})

describe('sync points', () => {
  it('deletes the caller\u2019s sync points, or only those of an api key', async () => {
    const { app, db } = await setup()
    const now = new Date().toISOString()

    await db
      .insertInto('sync_points')
      .values([
        { id: 'P1', user_id: 'U2', api_key_id: 'K2', created_date: now, last_modified_date: now },
        { id: 'P2', user_id: 'U2', api_key_id: 'K3', created_date: now, last_modified_date: now },
        { id: 'P3', user_id: 'U1', api_key_id: null, created_date: now, last_modified_date: now },
      ])
      .execute()
    await db
      .insertInto('sync_point_book')
      .values([
        { sync_point_id: 'P1', book_id: 'B1', created_date: now, last_modified_date: now },
        { sync_point_id: 'P2', book_id: 'B2', created_date: now, last_modified_date: now },
      ])
      .execute()

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/syncpoints/me?key_id=K2', headers: reader })
    expect(res.statusCode).toBe(204)

    expect((await db.selectFrom('sync_points').select('id').orderBy('id').execute()).map((row) => row.id)).toEqual([
      'P2',
      'P3',
    ])
    // The books of the removed point went with it.
    expect(
      (await db.selectFrom('sync_point_book').select('sync_point_id').execute()).map((row) => row.sync_point_id),
    ).toEqual(['P2'])

    // Without a key, everything of the caller goes, and nobody else's does.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/syncpoints/me', headers: reader })).statusCode).toBe(204)
    expect((await db.selectFrom('sync_points').select('id').execute()).map((row) => row.id)).toEqual(['P3'])

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/syncpoints/me' })).statusCode).toBe(401)
    await app.close()
  })
})

describe('filesystem browser', () => {
  it('lists roots, directories and files', async () => {
    const { app } = await setup()

    const roots = await app.inject({ method: 'POST', url: '/api/v1/filesystem', headers: admin, payload: {} })
    expect(roots.statusCode).toBe(200)
    const listing = roots.json() as { directories: unknown[]; files: unknown[]; parent?: string }
    expect(listing.directories.length).toBeGreaterThan(0)
    expect(listing.files).toEqual([])
    // Nothing above a root, so the field is left out.
    expect(listing.parent).toBeUndefined()

    const root = mkdtempSync(join(tmpdir(), 'ml-fs-'))
    mkdirSync(join(root, 'Beta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'book.cbz'), 'bytes')
    writeFileSync(join(root, '.secret.cbz'), 'bytes')

    const withoutFiles = await app.inject({
      method: 'POST',
      url: '/api/v1/filesystem',
      headers: admin,
      payload: { path: root },
    })
    const directoriesOnly = withoutFiles.json() as { directories: { name: string }[]; files: unknown[] }
    // Case-insensitive order, hidden entries left out.
    expect(directoriesOnly.directories.map((entry) => entry.name)).toEqual(['alpha', 'Beta'])
    expect(directoriesOnly.files).toEqual([])

    const withFiles = await app.inject({
      method: 'POST',
      url: '/api/v1/filesystem',
      headers: admin,
      payload: { path: root, showFiles: true },
    })
    const both = withFiles.json() as { directories: { name: string }[]; files: { name: string; path: string }[] }
    expect(both.directories.map((entry) => entry.name)).toEqual(['alpha', 'Beta'])
    expect(both.files.map((entry) => entry.name)).toEqual(['book.cbz'])
    expect(both.files[0]?.path).toBe(join(root, 'book.cbz'))

    // Pointing at a file lists the directory that holds it.
    const viaFile = await app.inject({
      method: 'POST',
      url: '/api/v1/filesystem',
      headers: admin,
      payload: { path: join(root, 'book.cbz'), showFiles: true },
    })
    expect((viaFile.json() as { files: unknown[] }).files).toHaveLength(1)

    await app.close()
  })

  it('refuses relative and missing paths, and non-admins', async () => {
    const { app } = await setup()

    const relative = await app.inject({
      method: 'POST',
      url: '/api/v1/filesystem',
      headers: admin,
      payload: { path: 'some/relative/path' },
    })
    expect(relative.statusCode).toBe(400)
    expect(relative.json()).toEqual({ message: 'Path must be absolute' })

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/filesystem',
          headers: admin,
          payload: { path: join(tmpdir(), 'ml-does-not-exist-42') },
        })
      ).statusCode,
    ).toBe(400)

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/filesystem', headers: reader, payload: {} })).statusCode,
    ).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/filesystem', payload: {} })).statusCode).toBe(401)

    await app.close()
  })
})
