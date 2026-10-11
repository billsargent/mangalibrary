import { mkdtempSync } from 'node:fs'
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

const ADMIN_KEY = 'admin-api-key'
const READER_KEY = 'reader-api-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-api-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

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
        shared_all_libraries: 0,
        age_restriction: 12,
        age_restriction_allow_only: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await database.db
    .insertInto('user_api_keys')
    .values([
      { id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now },
      { id: 'K2', user_id: 'U2', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now },
    ])
    .execute()

  await database.db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Secret', root: '/secret', created_date: now, last_modified_date: now },
    ])
    .execute()
  await database.db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

  await database.db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Akira',
      url: 'akira',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('series_metadata')
    .values({
      series_id: 'S1',
      title: 'Akira',
      title_sort: 'Akira',
      publisher: 'Kodansha',
      language: 'en',
      age_rating: 12,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('series_metadata_author')
    .values({ series_id: 'S1', name: 'Katsuhiro Otomo', role: 'writer' })
    .execute()
  await database.db.insertInto('series_metadata_tag').values({ series_id: 'S1', tag: 'cyberpunk' }).execute()
  await database.db.insertInto('series_metadata_genre').values({ series_id: 'S1', genre: 'Science Fiction' }).execute()
  await database.db.insertInto('series_metadata_sharing').values({ series_id: 'S1', label: 'mature' }).execute()
  await database.db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'v1.cbz',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('book_metadata')
    .values({ book_id: 'B1', title: 'Akira Volume One', created_date: now, last_modified_date: now })
    .execute()
  await database.db.insertInto('book_metadata_tag').values({ book_id: 'B1', tag: 'classic' }).execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('libraries', () => {
  it('requires authentication', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v1/libraries' })).statusCode).toBe(401)
    await app.close()
  })

  it('lists only the libraries the caller can access', async () => {
    const { app } = await setup()
    const all = await app.inject({ method: 'GET', url: '/api/v1/libraries', headers: admin })
    expect(all.json().map((library: { id: string }) => library.id).sort()).toEqual(['L1', 'L2'])

    const mine = await app.inject({ method: 'GET', url: '/api/v1/libraries', headers: reader })
    expect(mine.json().map((library: { id: string }) => library.id)).toEqual(['L1'])
    await app.close()
  })

  it('returns the documented LibraryDto shape', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/libraries/L1', headers: reader })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as Record<string, unknown>

    for (const key of [
      'id',
      'name',
      'root',
      'importComicInfoBook',
      'importComicInfoSeries',
      'importComicInfoCollection',
      'importComicInfoReadList',
      'importComicInfoSeriesAppendVolume',
      'importEpubBook',
      'importEpubSeries',
      'importMylarSeries',
      'importLocalArtwork',
      'importBarcodeIsbn',
      'scanForceModifiedTime',
      'scanOnStartup',
      'scanInterval',
      'scanCbx',
      'scanPdf',
      'scanEpub',
      'scanDirectoryExclusions',
      'repairExtensions',
      'convertToCbz',
      'emptyTrashAfterScan',
      'seriesCover',
      'hashFiles',
      'hashPages',
      'hashKoreader',
      'analyzeDimensions',
      'oneshotsDirectory',
      'unavailable',
    ]) {
      expect(dto, `missing ${key}`).toHaveProperty(key)
    }
    expect(typeof dto.importComicInfoBook).toBe('boolean')
    expect(dto.scanInterval).toBe('EVERY_6H')
    expect(dto.seriesCover).toBe('FIRST')
    expect(Array.isArray(dto.scanDirectoryExclusions)).toBe(true)
    await app.close()
  })

  it('forbids access to a library the caller cannot see', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v1/libraries/L2', headers: reader })).statusCode).toBe(403)
    await app.close()
  })

  it('creates, updates and deletes a library (admin only)', async () => {
    const { app } = await setup()

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/libraries', headers: reader, payload: { name: 'X', root: '/x' } }))
        .statusCode,
    ).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: admin,
      payload: { name: 'Comics', root: '/comics', scanDirectoryExclusions: ['#recycle', 'lost+found'] },
    })
    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string; name: string; scanDirectoryExclusions: string[] }
    expect(dto.name).toBe('Comics')
    expect(dto.scanDirectoryExclusions).toEqual(['#recycle', 'lost+found'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${dto.id}`,
      headers: admin,
      payload: { name: 'Renamed', hashPages: true },
    })
    expect(patched.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/api/v1/libraries/${dto.id}`, headers: admin })
    expect(after.json().name).toBe('Renamed')
    expect(after.json().hashPages).toBe(true)

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/libraries/${dto.id}`, headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/v1/libraries/${dto.id}`, headers: admin })).statusCode).toBe(404)
    await app.close()
  })

  it('queues a scan as an accepted job', async () => {
    const { app, database } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/libraries/L1/scan', headers: admin, payload: { deep: true } })
    expect(res.statusCode).toBe(202)

    const jobs = await database.db.selectFrom('jobs').selectAll().execute()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.type).toBe('ScanLibrary')
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ libraryId: 'L1', scanDeep: true })
    await app.close()
  })
})

describe('referentials', () => {
  it('returns distinct values for the visible content', async () => {
    const { app } = await setup()
    const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: admin })).json()

    expect(await get('/api/v1/genres')).toEqual(['Science Fiction'])
    expect(await get('/api/v1/tags')).toEqual(['cyberpunk'])
    expect(await get('/api/v1/tags/book')).toEqual(['classic'])
    expect(await get('/api/v1/publishers')).toEqual(['Kodansha'])
    expect(await get('/api/v1/languages')).toEqual(['en'])
    expect(await get('/api/v1/sharing-labels')).toEqual(['mature'])
    expect(await get('/api/v1/age-ratings')).toEqual(['12'])
    expect(await get('/api/v1/authors')).toEqual([{ name: 'Katsuhiro Otomo', role: 'writer' }])
    expect(await get('/api/v1/authors/names')).toEqual(['Katsuhiro Otomo'])
    expect(await get('/api/v1/authors/roles')).toEqual(['writer'])
    await app.close()
  })

  it('wraps v2 referentials in a Spring page', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v2/genres', headers: admin })
    const page = res.json() as { content: string[]; totalElements: number; size: number; number: number; pageable: unknown }
    expect(page.content).toEqual(['Science Fiction'])
    expect(page.totalElements).toBe(1)
    expect(page.size).toBe(20)
    expect(page.number).toBe(0)
    expect(page).toHaveProperty('pageable')
    await app.close()
  })

  it('is empty for a user with no accessible libraries', async () => {
    const { app, database } = await setup()
    await database.db.deleteFrom('user_library_sharing').where('user_id', '=', 'U2').execute()
    const res = await app.inject({ method: 'GET', url: '/api/v1/genres', headers: reader })
    expect(res.json()).toEqual([])
    await app.close()
  })
})

describe('users', () => {
  it('returns the authenticated user from /me', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v2/users/me', headers: reader })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as Record<string, unknown>
    expect(dto.id).toBe('U2')
    expect(dto.email).toBe('reader@example.com')
    expect(dto.roles).toEqual(['PAGE_STREAMING'])
    expect(dto.sharedAllLibraries).toBe(false)
    expect(dto.sharedLibrariesIds).toEqual(['L1'])
    expect(dto.ageRestriction).toEqual({ age: 12, restriction: 'ALLOW_ONLY' })
    expect(dto.labelsAllow).toEqual([])
    await app.close()
  })

  it('creates, updates and deletes a user (admin only)', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v2/users', headers: reader })).statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: {
        email: 'new@example.com',
        password: 'secret',
        roles: ['FILE_DOWNLOAD'],
        sharedLibraries: { all: false, libraryIds: ['L1'] },
        labelsAllow: ['kids'],
        labelsExclude: ['mature'],
        ageRestriction: { age: 10, restriction: 'ALLOW_ONLY' },
      },
    })
    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string }
    expect(dto.id).toBeTruthy()

    const fetched = await app.inject({ method: 'GET', url: `/api/v2/users/${dto.id}`, headers: admin })
    expect(fetched.json().sharedLibrariesIds).toEqual(['L1'])
    expect(fetched.json().labelsAllow).toEqual(['kids'])
    expect(fetched.json().labelsExclude).toEqual(['mature'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/users/${dto.id}`,
      headers: admin,
      payload: { roles: ['ADMIN'], ageRestriction: { age: 0, restriction: 'NONE' } },
    })
    expect(patched.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/api/v2/users/${dto.id}`, headers: admin })
    expect(after.json().roles).toEqual(['ADMIN'])
    expect(after.json().ageRestriction).toBeUndefined()

    expect((await app.inject({ method: 'DELETE', url: `/api/v2/users/${dto.id}`, headers: admin })).statusCode).toBe(204)
    await app.close()
  })

  it('manages API keys for the current user', async () => {
    const { app } = await setup()
    const list = await app.inject({ method: 'GET', url: '/api/v2/users/me/api-keys', headers: admin })
    expect(list.json()).toHaveLength(1)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/users/me/api-keys',
      headers: admin,
      payload: { comment: 'test key' },
    })
    expect(created.statusCode).toBe(200)
    const key = created.json() as { id: string; key: string; comment: string; userId: string }
    expect(key.comment).toBe('test key')
    expect(key.userId).toBe('U1')
    expect(key.key.length).toBeGreaterThan(10)

    expect((await app.inject({ method: 'DELETE', url: `/api/v2/users/me/api-keys/${key.id}`, headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v2/users/me/api-keys', headers: admin })).json()).toHaveLength(1)
    await app.close()
  })

  it('records and returns authentication activity', async () => {
    const { app } = await setup()
    await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'admin@example.com', password: 'wrong' },
    })

    const mine = await app.inject({ method: 'GET', url: '/api/v2/users/me/authentication-activity', headers: admin })
    const page = mine.json() as { content: { success: boolean }[]; totalElements: number }
    expect(page.totalElements).toBe(1)
    expect(page.content[0]?.success).toBe(false)

    const all = await app.inject({ method: 'GET', url: '/api/v2/users/authentication-activity', headers: admin })
    expect((all.json() as { totalElements: number }).totalElements).toBe(1)
    await app.close()
  })
})
