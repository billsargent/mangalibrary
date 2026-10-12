import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from './app.js'
import { hashPassword } from './auth/passwords.js'
import { loadConfig } from './config.js'
import { createDatabase, type Database } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import type { SseEvent } from './events.js'

const ADMIN_KEY = 'admin-key'
const admin = { 'x-api-key': ADMIN_KEY }

interface Fixture {
  app: FastifyInstance
  database: Database
  /** The events published while the test ran, in order. */
  published: SseEvent[]
}

/** A server with one library, one series and one book, and an admin to change things. */
async function setup(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'ml-events-root-'))
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-events-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
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
  await db
    .insertInto('user_api_keys')
    .values({ id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now })
    .execute()
  await db
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
  await db
    .insertInto('series_metadata')
    .values({ series_id: 'S1', title: 'Akira', title_sort: 'Akira', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'akira/v1.cbz',
      file_last_modified: now,
      file_size: 0,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('book_metadata')
    .values({
      book_id: 'B1',
      title: 'Volume 1',
      number: '1',
      number_sort: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()

  const published: SseEvent[] = []
  app.events.subscribe((event) => published.push(event))
  return { app, database, published }
}

/** The names and payloads of what was published. */
function seen(published: readonly SseEvent[]): { name: string; data: unknown }[] {
  return published.map((event) => ({ name: event.name, data: event.data }))
}

describe('announcing a change', () => {
  it('names a library with its own id', async () => {
    const { app, published } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: admin,
      payload: { name: 'Other', root: '/other' },
    })
    expect(created.statusCode).toBe(200)
    const libraryId = (created.json() as { id: string }).id

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${libraryId}`,
      headers: admin,
      payload: { name: 'Renamed' },
    })
    await app.inject({ method: 'DELETE', url: `/api/v1/libraries/${libraryId}`, headers: admin })

    expect(seen(published)).toEqual([
      { name: 'LibraryAdded', data: { libraryId } },
      { name: 'LibraryChanged', data: { libraryId } },
      { name: 'LibraryDeleted', data: { libraryId } },
    ])
    await app.close()
  })

  it('names a collection with the series it holds', async () => {
    const { app, published } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: admin,
      payload: { name: 'Favourites', seriesIds: ['S1'] },
    })
    const collectionId = (created.json() as { id: string }).id

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}`,
      headers: admin,
      payload: { name: 'Best' },
    })
    await app.inject({ method: 'DELETE', url: `/api/v1/collections/${collectionId}`, headers: admin })

    expect(seen(published)).toEqual([
      { name: 'CollectionAdded', data: { collectionId, seriesIds: ['S1'] } },
      { name: 'CollectionChanged', data: { collectionId, seriesIds: ['S1'] } },
      { name: 'CollectionDeleted', data: { collectionId, seriesIds: ['S1'] } },
    ])
    await app.close()
  })

  it('names a read list with the books it holds', async () => {
    const { app, published } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/readlists',
      headers: admin,
      payload: { name: 'To read', bookIds: ['B1'] },
    })
    const readListId = (created.json() as { id: string }).id

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/readlists/${readListId}`,
      headers: admin,
      payload: { name: 'Next' },
    })
    await app.inject({ method: 'DELETE', url: `/api/v1/readlists/${readListId}`, headers: admin })

    expect(seen(published)).toEqual([
      { name: 'ReadListAdded', data: { readListId, bookIds: ['B1'] } },
      { name: 'ReadListChanged', data: { readListId, bookIds: ['B1'] } },
      { name: 'ReadListDeleted', data: { readListId, bookIds: ['B1'] } },
    ])
    await app.close()
  })

  it('names a book with its series and library, and its series too', async () => {
    const { app, published } = await setup()

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B1/metadata',
      headers: admin,
      payload: { title: 'Akira Volume One' },
    })

    expect(seen(published)).toEqual([
      { name: 'BookChanged', data: { bookId: 'B1', seriesId: 'S1', libraryId: 'L1' } },
      { name: 'SeriesChanged', data: { seriesId: 'S1', libraryId: 'L1' } },
    ])
    await app.close()
  })

  it('announces every book of a bulk edit, and each series once', async () => {
    const { app, published } = await setup()

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/metadata',
      headers: admin,
      payload: { B1: { title: 'Renamed' } },
    })

    expect(seen(published)).toEqual([
      { name: 'BookChanged', data: { bookId: 'B1', seriesId: 'S1', libraryId: 'L1' } },
      { name: 'SeriesChanged', data: { seriesId: 'S1', libraryId: 'L1' } },
    ])
    await app.close()
  })

  it('names a series on its own when its metadata is edited', async () => {
    const { app, published } = await setup()

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      headers: admin,
      payload: { title: 'Akira (2)' },
    })

    expect(seen(published)).toEqual([{ name: 'SeriesChanged', data: { seriesId: 'S1', libraryId: 'L1' } }])
    await app.close()
  })

  it('says nothing when a change was refused', async () => {
    const { app, published } = await setup()

    // Not an admin, and requests that fail validation: none of them changes
    // anything, so none of them announces anything.
    const unauthorised = await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      payload: { title: 'Nope' },
    })
    expect(unauthorised.statusCode).toBe(401)

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      headers: admin,
      payload: { title: 42 },
    })
    expect(invalid.statusCode).toBe(400)

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/NOPE/metadata',
      headers: admin,
      payload: { title: 'x' },
    })
    expect(missing.statusCode).toBe(404)

    expect(published).toEqual([])
    await app.close()
  })
})
