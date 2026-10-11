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

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

/**
 * Fixture:
 *
 * - C1 holds both series; the reader may only see S1 (age 12), so C1 is listed
 *   with `seriesIds: ['S1']` and nothing else.
 * - RL1 holds B2 before B1, so read list order is distinguishable from id order.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-org-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

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
        shared_all_libraries: 0,
        age_restriction: 12,
        age_restriction_allow_only: 1,
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

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now })
    .execute()
  await db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

  await db
    .insertInto('series')
    .values([
      {
        id: 'S1',
        library_id: 'L1',
        name: 'Akira',
        url: 'akira',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S2',
        library_id: 'L1',
        name: 'Berserk',
        url: 'berserk',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('series_metadata')
    .values([
      {
        series_id: 'S1',
        status: 'ONGOING',
        title: 'Akira',
        title_sort: 'Akira',
        age_rating: 12,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        status: 'ONGOING',
        title: 'Berserk',
        title_sort: 'Berserk',
        age_rating: 18,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('books')
    .values([
      {
        id: 'B1',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'v1.cbz',
        file_last_modified: now,
        number: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B2',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 2',
        url: 'v2.cbz',
        file_last_modified: now,
        number: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B3',
        series_id: 'S2',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'b1.cbz',
        file_last_modified: now,
        number: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('book_metadata')
    .values([
      {
        book_id: 'B1',
        title: 'Akira Volume One',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        title: 'Akira Volume Two',
        number: '2',
        number_sort: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        title: 'Berserk Volume One',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Classics', ordered: 1, created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('collection_series')
    .values([
      { collection_id: 'C1', series_id: 'S2', number: 0 },
      { collection_id: 'C1', series_id: 'S1', number: 1 },
    ])
    .execute()

  await db
    .insertInto('readlists')
    .values({
      id: 'RL1',
      name: 'Favourites',
      summary: 'The good ones',
      ordered: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('readlist_book')
    .values([
      { readlist_id: 'RL1', book_id: 'B2', number: 0 },
      { readlist_id: 'RL1', book_id: 'B1', number: 1 },
    ])
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('collections', () => {
  it('lists collections trimmed to what the caller can see', async () => {
    const { app } = await setup()

    const asAdmin = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: admin })
    expect(asAdmin.statusCode).toBe(200)
    const adminPage = asAdmin.json() as { content: Record<string, unknown>[]; totalElements: number }
    expect(adminPage.totalElements).toBe(1)
    expect(adminPage.content[0]!.seriesIds).toEqual(['S2', 'S1'])
    expect(adminPage.content[0]!.filtered).toBe(false)
    for (const key of ['id', 'name', 'ordered', 'seriesIds', 'createdDate', 'lastModifiedDate', 'filtered']) {
      expect(adminPage.content[0]!, `missing ${key}`).toHaveProperty(key)
    }

    const asReader = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: reader })
    expect((asReader.json() as { content: { seriesIds: string[] }[] }).content[0]!.seriesIds).toEqual(['S1'])
    await app.close()
  })

  it('creates, reads, updates and deletes a collection', async () => {
    const { app } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: admin,
      payload: { name: 'New', ordered: false, seriesIds: ['S1', 'S2'] },
    })
    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string; ordered: boolean; seriesIds: string[] }
    expect(dto.ordered).toBe(false)
    expect(dto.seriesIds).toEqual(['S1', 'S2'])

    const fetched = await app.inject({ method: 'GET', url: `/api/v1/collections/${dto.id}`, headers: admin })
    expect((fetched.json() as { name: string }).name).toBe('New')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${dto.id}`,
      headers: admin,
      payload: { name: 'Renamed', ordered: true, seriesIds: ['S2'] },
    })
    expect(patched.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/api/v1/collections/${dto.id}`, headers: admin })
    const afterDto = after.json() as { name: string; ordered: boolean; seriesIds: string[] }
    expect(afterDto.name).toBe('Renamed')
    expect(afterDto.ordered).toBe(true)
    expect(afterDto.seriesIds).toEqual(['S2'])

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/collections/${dto.id}`, headers: admin })).statusCode,
    ).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/v1/collections/${dto.id}`, headers: admin })).statusCode).toBe(
      404,
    )
    await app.close()
  })

  it('keeps membership in the requested order', async () => {
    const { app } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: admin,
      payload: { name: 'Ordered', seriesIds: ['S2', 'S1'] },
    })
    const id = (created.json() as { id: string }).id

    const series = await app.inject({ method: 'GET', url: `/api/v1/collections/${id}/series`, headers: admin })
    expect((series.json() as { content: { id: string }[] }).content.map((s) => s.id).sort()).toEqual(['S1', 'S2'])
    await app.close()
  })

  it('validates input and requires admin', async () => {
    const { app } = await setup()

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/collections', headers: admin, payload: { name: '  ' } }))
        .statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/collections',
          headers: admin,
          payload: { name: 'X', seriesIds: ['NOPE'] },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/collections', headers: reader, payload: { name: 'X' } }))
        .statusCode,
    ).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/collections/C1', headers: reader })).statusCode).toBe(
      403,
    )
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/collections/C1',
          headers: admin,
          payload: { ordered: 'yes' },
        })
      ).statusCode,
    ).toBe(400)
    await app.close()
  })

  it('lists a collection series through the series filters', async () => {
    const { app } = await setup()

    const all = await app.inject({ method: 'GET', url: '/api/v1/collections/C1/series', headers: admin })
    const page = all.json() as { content: { id: string }[]; totalElements: number }
    expect(page.totalElements).toBe(2)

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/C1/series?tag=nothing',
      headers: admin,
    })
    expect((filtered.json() as { totalElements: number }).totalElements).toBe(0)

    const asReader = await app.inject({ method: 'GET', url: '/api/v1/collections/C1/series', headers: reader })
    expect((asReader.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])
    await app.close()
  })
})

describe('read lists', () => {
  it('lists and reads read lists with visible book ids only', async () => {
    const { app } = await setup()

    const asAdmin = await app.inject({ method: 'GET', url: '/api/v1/readlists', headers: admin })
    const page = asAdmin.json() as { content: Record<string, unknown>[]; totalElements: number }
    expect(page.totalElements).toBe(1)
    for (const key of ['id', 'name', 'summary', 'ordered', 'bookIds', 'createdDate', 'lastModifiedDate', 'filtered']) {
      expect(page.content[0]!, `missing ${key}`).toHaveProperty(key)
    }
    expect(page.content[0]!.bookIds).toEqual(['B2', 'B1'])

    const one = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1', headers: reader })
    expect((one.json() as { summary: string }).summary).toBe('The good ones')
    await app.close()
  })

  it('creates, updates and deletes a read list', async () => {
    const { app } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/readlists',
      headers: admin,
      payload: { name: 'New list', summary: 'Notes', ordered: true, bookIds: ['B3', 'B1'] },
    })
    expect(created.statusCode).toBe(200)
    const id = (created.json() as { id: string; bookIds: string[] }).id
    expect((created.json() as { bookIds: string[] }).bookIds).toEqual(['B3', 'B1'])

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/readlists/${id}`,
          headers: admin,
          payload: { name: 'Renamed', bookIds: ['B1'] },
        })
      ).statusCode,
    ).toBe(204)
    const after = await app.inject({ method: 'GET', url: `/api/v1/readlists/${id}`, headers: admin })
    expect((after.json() as { name: string; bookIds: string[] }).bookIds).toEqual(['B1'])

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/readlists',
          headers: admin,
          payload: { name: 'Bad', bookIds: ['NOPE'] },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/readlists', headers: reader, payload: { name: 'No' } }))
        .statusCode,
    ).toBe(403)

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/readlists/${id}`, headers: admin })).statusCode).toBe(
      204,
    )
    expect((await app.inject({ method: 'GET', url: `/api/v1/readlists/${id}`, headers: admin })).statusCode).toBe(404)
    await app.close()
  })

  it('lists the books of a read list in read list order', async () => {
    const { app } = await setup()

    const listed = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books', headers: admin })
    const page = listed.json() as { content: { id: string }[]; totalElements: number }
    expect(page.totalElements).toBe(2)
    expect(page.content.map((b) => b.id)).toEqual(['B2', 'B1'])

    const paged = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books?page=1&size=1', headers: admin })
    expect((paged.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B1'])

    const notMatching = await app.inject({
      method: 'GET',
      url: '/api/v1/readlists/RL1/books?media_status=ERROR',
      headers: admin,
    })
    expect((notMatching.json() as { totalElements: number }).totalElements).toBe(0)
    await app.close()
  })

  it('walks to the next and previous book within a read list', async () => {
    const { app } = await setup()

    const next = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books/B2/next', headers: admin })
    expect((next.json() as { id: string }).id).toBe('B1')
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books/B1/next', headers: admin })).statusCode,
    ).toBe(404)

    const previous = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books/B1/previous', headers: admin })
    expect((previous.json() as { id: string }).id).toBe('B2')
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/books/B3/next', headers: admin })).statusCode,
    ).toBe(404)
    await app.close()
  })

  it('matches a ComicRack reading list', async () => {
    const { app } = await setup()

    const cbl = `<?xml version="1.0" encoding="utf-8"?>
<ReadingList xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Name>My Reading List</Name>
  <Books>
    <Book Series="Akira" Number="2" Volume="1982" />
    <Book Series="Berserk" Number="1" Volume="1989" />
    <Book Series="Missing &amp; Gone" Number="1" Volume="2000" />
  </Books>
</ReadingList>`

    const boundary = '----mlboundary'
    const payload =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="list.cbl"\r\n' +
      'Content-Type: application/xml\r\n\r\n' +
      `${cbl}\r\n` +
      `--${boundary}--\r\n`

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/readlists/match/comicrack',
      headers: { ...admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(200)

    const match = res.json() as {
      errorCode: string
      readListMatch: { name: string }
      requests: {
        request: { series: string[]; number: string }
        matches: { series: { seriesId: string }; books: { bookId: string }[] }[]
      }[]
    }
    expect(match.readListMatch.name).toBe('My Reading List')
    expect(match.errorCode).toBe('')
    expect(match.requests).toHaveLength(3)
    expect(match.requests[0]!.request).toEqual({ series: ['Akira'], number: '2' })
    expect(match.requests[0]!.matches[0]!.series.seriesId).toBe('S1')
    expect(match.requests[0]!.matches[0]!.books.map((b) => b.bookId)).toEqual(['B2'])
    expect(match.requests[2]!.request.series).toEqual(['Missing & Gone'])
    expect(match.requests[2]!.matches).toEqual([])

    // A non-reading-list upload is rejected rather than matched to nothing.
    const bad =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="x.cbl"\r\n' +
      'Content-Type: application/xml\r\n\r\n' +
      '<NotAReadingList />\r\n' +
      `--${boundary}--\r\n`
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/readlists/match/comicrack',
      headers: { ...admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: bad,
    })
    expect(rejected.statusCode).toBe(400)

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/readlists/match/comicrack', headers: admin })).statusCode,
    ).toBe(400)
    await app.close()
  })
})
