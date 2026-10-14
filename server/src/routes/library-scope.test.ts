import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { hashApiKey } from '../auth/users.js'

const admin = { 'x-api-key': 'admin-key' }
const member = { 'x-api-key': 'member-key' }

interface Page {
  content: { id: string }[]
  totalElements: number
  size: number
}

/**
 * Fixture: two libraries, and a member who is shared only the first.
 *
 * The member has no age or label restriction on purpose. A restricted user is
 * also filtered series by series, which hides a library that leaked through; an
 * unrestricted one is held back by the library list alone, so this is the user a
 * mistake in that list shows on.
 *
 * - L1 "Shared": S1 with B1 (read by the member), B2 (unread) and B3 (no pages).
 * - L2 "Private": S2 with B4 (marked read by the member, as if shared once) and B5.
 * - A collection and a read list in each library.
 */
async function setup(): Promise<FastifyInstance> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-scope-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db
  const dates = { created_date: now, last_modified_date: now }

  await db
    .insertInto('users')
    .values([
      {
        id: 'U1',
        email: 'admin@example.com',
        password: hashPassword('admin-pass'),
        roles: JSON.stringify(['ADMIN']),
        shared_all_libraries: 1,
        ...dates,
      },
      {
        id: 'U2',
        email: 'member@example.com',
        password: hashPassword('member-pass'),
        roles: JSON.stringify(['PAGE_STREAMING']),
        shared_all_libraries: 0,
        ...dates,
      },
    ])
    .execute()
  await db
    .insertInto('user_api_keys')
    .values([
      { id: 'K1', user_id: 'U1', key: hashApiKey('admin-key'), comment: 'admin', ...dates },
      { id: 'K2', user_id: 'U2', key: hashApiKey('member-key'), comment: 'member', ...dates },
    ])
    .execute()

  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Shared', root: '/shared', ...dates },
      { id: 'L2', name: 'Private', root: '/private', ...dates },
    ])
    .execute()
  await db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

  await db
    .insertInto('series')
    .values([
      { id: 'S1', library_id: 'L1', name: 'Akira', url: 'akira', file_last_modified: now, ...dates },
      { id: 'S2', library_id: 'L2', name: 'Hidden', url: 'hidden', file_last_modified: now, ...dates },
    ])
    .execute()
  await db
    .insertInto('series_metadata')
    .values([
      { series_id: 'S1', status: 'ONGOING', title: 'Akira', title_sort: 'Akira', ...dates },
      { series_id: 'S2', status: 'ONGOING', title: 'Hidden', title_sort: 'Hidden', ...dates },
    ])
    .execute()
  await db
    .insertInto('book_metadata_aggregation')
    .values([
      { series_id: 'S1', release_date: '1982-12-20', ...dates },
      { series_id: 'S2', release_date: '1999-01-01', ...dates },
    ])
    .execute()

  const books = [
    { id: 'B1', series_id: 'S1', library_id: 'L1', number: 1, pages: 20 },
    { id: 'B2', series_id: 'S1', library_id: 'L1', number: 2, pages: 20 },
    { id: 'B3', series_id: 'S1', library_id: 'L1', number: 3, pages: 0 },
    { id: 'B4', series_id: 'S2', library_id: 'L2', number: 1, pages: 20 },
    { id: 'B5', series_id: 'S2', library_id: 'L2', number: 2, pages: 20 },
  ]
  await db
    .insertInto('books')
    .values(
      books.map((book) => ({
        id: book.id,
        series_id: book.series_id,
        library_id: book.library_id,
        name: `Volume ${book.number}`,
        url: `${book.id}.cbz`,
        file_last_modified: now,
        file_size: 1024,
        number: book.number,
        ...dates,
      })),
    )
    .execute()
  await db
    .insertInto('book_metadata')
    .values(
      books.map((book) => ({
        book_id: book.id,
        title: `Volume ${book.number}`,
        number: String(book.number),
        number_sort: book.number,
        release_date: book.library_id === 'L1' ? '1982-12-20' : '1999-01-01',
        ...dates,
      })),
    )
    .execute()
  await db
    .insertInto('media')
    .values(
      books.map((book) => ({
        book_id: book.id,
        media_type: 'application/vnd.comicbook+zip',
        status: 'READY',
        page_count: book.pages,
        ...dates,
      })),
    )
    .execute()

  await db
    .insertInto('read_progress')
    .values(
      ['B1', 'B4'].map((bookId) => ({
        user_id: 'U2',
        book_id: bookId,
        page: 20,
        completed: 1,
        read_date: now,
        ...dates,
      })),
    )
    .execute()

  await db
    .insertInto('collections')
    .values([
      { id: 'C1', name: 'Shared shelf', ...dates },
      { id: 'C2', name: 'Private shelf', ...dates },
    ])
    .execute()
  await db
    .insertInto('collection_series')
    .values([
      { collection_id: 'C1', series_id: 'S1' },
      { collection_id: 'C2', series_id: 'S2' },
    ])
    .execute()
  await db
    .insertInto('readlists')
    .values([
      { id: 'R1', name: 'Shared list', ...dates },
      { id: 'R2', name: 'Private list', ...dates },
    ])
    .execute()
  await db
    .insertInto('readlist_book')
    .values([
      { readlist_id: 'R1', book_id: 'B1', number: 0 },
      { readlist_id: 'R1', book_id: 'B2', number: 1 },
      { readlist_id: 'R1', book_id: 'B3', number: 2 },
      { readlist_id: 'R2', book_id: 'B4', number: 0 },
    ])
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return app
}

async function page(app: FastifyInstance, url: string, headers: Record<string, string>): Promise<Page> {
  const res = await app.inject({ method: 'GET', url, headers })
  expect(res.statusCode, url).toBe(200)
  return res.json() as Page
}

const ids = (result: Page): string[] => result.content.map((entry) => entry.id).sort()

describe('library_id narrows what the caller may see, and never widens it', () => {
  const listings = [
    '/api/v1/books',
    '/api/v1/books/ondeck',
    '/api/v1/series',
    '/api/v1/series/new',
    '/api/v1/series/updated',
    '/api/v1/collections',
    '/api/v1/readlists',
  ]

  it.each(listings)('%s answers nothing for a library that is not shared with the caller', async (path) => {
    const app = await setup()

    const result = await page(app, `${path}?library_id=L2`, member)
    expect(result.content).toEqual([])
    expect(result.totalElements).toBe(0)

    await app.close()
  })

  it.each(listings)('%s still answers an administrator who names that library', async (path) => {
    const app = await setup()

    // On deck is per reader, and the administrator has read nothing.
    if (path !== '/api/v1/books/ondeck') {
      expect((await page(app, `${path}?library_id=L2`, admin)).totalElements).toBeGreaterThan(0)
    }

    await app.close()
  })

  it('keeps the libraries the caller may see out of a list that also names one they may not', async () => {
    const app = await setup()

    expect(ids(await page(app, '/api/v1/books?library_id=L1&library_id=L2', member))).toEqual(['B1', 'B2', 'B3'])
    expect(ids(await page(app, '/api/v1/series?library_id=L1&library_id=L2', member))).toEqual(['S1'])
    expect(ids(await page(app, '/api/v1/collections?library_id=L1&library_id=L2', member))).toEqual(['C1'])
    expect(ids(await page(app, '/api/v1/readlists?library_id=L1&library_id=L2', member))).toEqual(['R1'])

    await app.close()
  })

  it('does not tell the release dates of a library that is not shared', async () => {
    const app = await setup()

    const hidden = await app.inject({
      method: 'GET',
      url: '/api/v1/series/release-dates?library_id=L2',
      headers: member,
    })
    expect(hidden.json()).toEqual([])

    const own = await app.inject({ method: 'GET', url: '/api/v1/series/release-dates', headers: member })
    expect(own.json()).toEqual(['1982'])

    await app.close()
  })

  it('answers the same for a library that is not shared and one that does not exist', async () => {
    const app = await setup()

    const hidden = await page(app, '/api/v1/books?library_id=L2', member)
    const missing = await page(app, '/api/v1/books?library_id=NOPE', member)
    expect(hidden).toEqual(missing)

    await app.close()
  })
})

describe('unpaged switches paging off, and filters nothing', () => {
  it('returns every book in one page, with or without pages of its own', async () => {
    const app = await setup()

    const all = await page(app, '/api/v1/books?unpaged=true&size=1', member)
    expect(ids(all)).toEqual(['B1', 'B2', 'B3'])
    expect(all.size).toBe(3)

    await app.close()
  })

  it('pages as usual when it is false or absent, without dropping the book that has no pages', async () => {
    const app = await setup()

    for (const url of ['/api/v1/books?unpaged=false&size=2', '/api/v1/books?size=2']) {
      const first = await page(app, url, member)
      expect(first.content).toHaveLength(2)
      expect(first.totalElements).toBe(3)
    }

    await app.close()
  })

  it('returns a series whose books have pages', async () => {
    const app = await setup()

    expect(ids(await page(app, '/api/v1/series?unpaged=true', member))).toEqual(['S1'])
    expect(ids(await page(app, '/api/v1/series?unpaged=false', admin))).toEqual(['S1', 'S2'])
    expect(ids(await page(app, '/api/v1/series/new?unpaged=true', admin))).toEqual(['S1', 'S2'])

    await app.close()
  })

  it('returns the whole of a read list', async () => {
    const app = await setup()

    expect(ids(await page(app, '/api/v1/readlists/R1/books?unpaged=true', member))).toEqual(['B1', 'B2', 'B3'])
    expect(ids(await page(app, '/api/v1/series/S1/books?unpaged=true', member))).toEqual(['B1', 'B2', 'B3'])

    await app.close()
  })
})
