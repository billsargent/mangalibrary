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
import { groupOf } from './series.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

/**
 * Fixture:
 *
 * - L1 "Main" (S1 Akira age 12, S2 Berserk age 18), L2 "Secret" (S3) - the reader
 *   may only see L1 and has an ALLOW_ONLY 12 age restriction, so S2 is invisible.
 * - S1 has two books; the reader has finished B1, which puts S1 in progress and
 *   leaves B2 as the next thing to read.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-content-')),
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
    .values([
      { id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Secret', root: '/secret', created_date: now, last_modified_date: now },
    ])
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
      {
        id: 'S3',
        library_id: 'L2',
        name: 'Secret Series',
        url: 'secret',
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
        publisher: 'Kodansha',
        language: 'en',
        age_rating: 12,
        total_book_count: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        status: 'ENDED',
        title: 'Berserk',
        title_sort: 'Berserk',
        publisher: 'Hakusensha',
        language: 'en',
        age_rating: 18,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S3',
        status: 'ONGOING',
        title: 'Secret Series',
        title_sort: 'Secret Series',
        publisher: 'Unknown',
        language: 'fr',
        age_rating: 6,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('series_metadata_author')
    .values({ series_id: 'S1', name: 'Katsuhiro Otomo', role: 'writer' })
    .execute()
  await db.insertInto('series_metadata_tag').values({ series_id: 'S1', tag: 'cyberpunk' }).execute()
  await db.insertInto('series_metadata_genre').values({ series_id: 'S1', genre: 'Science Fiction' }).execute()
  await db.insertInto('series_metadata_sharing').values({ series_id: 'S1', label: 'mature' }).execute()

  await db
    .insertInto('book_metadata_aggregation')
    .values({
      series_id: 'S1',
      summary: 'Neo-Tokyo',
      summary_number: '1',
      release_date: '1982-12-20',
      created_date: now,
      last_modified_date: now,
    })
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
        file_size: 1024,
        file_hash: 'HASH1',
        number: 1,
        created_date: '2023-01-01T00:00:00.000Z',
        last_modified_date: now,
      },
      {
        id: 'B2',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 2',
        url: 'v2.cbz',
        file_last_modified: now,
        file_size: 2048,
        file_hash: 'HASH1',
        number: 2,
        created_date: '2023-02-01T00:00:00.000Z',
        last_modified_date: now,
      },
      {
        id: 'B3',
        series_id: 'S2',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'b1.cbz',
        file_last_modified: now,
        file_size: 4096,
        file_hash: 'HASH2',
        number: 1,
        created_date: '2023-03-01T00:00:00.000Z',
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
        release_date: '1982-12-20',
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        title: 'Akira Volume Two',
        number: '2',
        number_sort: 2,
        release_date: '1985-01-15',
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        title: 'Berserk Volume One',
        number: '1',
        number_sort: 1,
        release_date: '1989-11-01',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()
  await db.insertInto('book_metadata_tag').values({ book_id: 'B1', tag: 'classic' }).execute()

  await db
    .insertInto('media')
    .values([
      {
        book_id: 'B1',
        media_type: 'application/vnd.comicbook+zip',
        status: 'READY',
        page_count: 200,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        media_type: 'application/vnd.comicbook+zip',
        status: 'READY',
        page_count: 0,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        media_type: 'application/pdf',
        status: 'READY',
        page_count: 100,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('read_progress')
    .values({
      user_id: 'U2',
      book_id: 'B1',
      page: 200,
      completed: 1,
      read_date: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  await db
    .insertInto('readlists')
    .values({ id: 'RL1', name: 'Favourites', created_date: now, last_modified_date: now })
    .execute()
  await db.insertInto('readlist_book').values({ readlist_id: 'RL1', book_id: 'B1' }).execute()
  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Classics', created_date: now, last_modified_date: now })
    .execute()
  await db.insertInto('collection_series').values({ collection_id: 'C1', series_id: 'S1' }).execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('series listing', () => {
  it('returns a Spring page of the documented SeriesDto shape', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/series', headers: reader })
    expect(res.statusCode).toBe(200)

    const page = res.json() as { content: Record<string, unknown>[]; totalElements: number; size: number }
    expect(page.totalElements).toBe(1)
    const dto = page.content[0]!

    for (const key of [
      'id',
      'libraryId',
      'name',
      'url',
      'oneshot',
      'booksCount',
      'booksReadCount',
      'booksUnreadCount',
      'booksInProgressCount',
      'deleted',
      'created',
      'lastModified',
      'fileLastModified',
      'metadata',
      'booksMetadata',
    ]) {
      expect(dto, `missing ${key}`).toHaveProperty(key)
    }

    const metadata = dto.metadata as Record<string, unknown>
    for (const key of [
      'status',
      'title',
      'titleSort',
      'publisher',
      'language',
      'ageRating',
      'readingDirection',
      'summary',
      'totalBookCount',
      'sharingLabels',
      'tags',
      'genres',
      'links',
      'alternateTitles',
      'created',
      'lastModified',
    ]) {
      expect(metadata, `missing metadata.${key}`).toHaveProperty(key)
    }
    expect(metadata.titleLock).toBe(false)
    expect(metadata.tags).toEqual(['cyberpunk'])
    expect(metadata.sharingLabels).toEqual(['mature'])
    expect(dto.booksCount).toBe(2)
    expect(dto.booksReadCount).toBe(1)
    expect(dto.booksInProgressCount).toBe(0)
    expect(dto.booksUnreadCount).toBe(1)
    await app.close()
  })

  it('hides series the caller cannot reach, by library and by age restriction', async () => {
    const { app } = await setup()
    const mine = await app.inject({ method: 'GET', url: '/api/v1/series', headers: reader })
    expect((mine.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    const all = await app.inject({ method: 'GET', url: '/api/v1/series', headers: admin })
    expect((all.json() as { totalElements: number }).totalElements).toBe(3)

    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S2', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S3', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/series/NOPE', headers: admin })).statusCode).toBe(404)
    await app.close()
  })

  it('honours filters, sorting and paging', async () => {
    const { app } = await setup()

    const byTag = await app.inject({ method: 'GET', url: '/api/v1/series?tag=cyberpunk', headers: admin })
    expect((byTag.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    const byAuthor = await app.inject({
      method: 'GET',
      url: '/api/v1/series?author=Katsuhiro%20Otomo',
      headers: admin,
    })
    expect((byAuthor.json() as { totalElements: number }).totalElements).toBe(1)

    const byPublisher = await app.inject({ method: 'GET', url: '/api/v1/series?publisher=Hakusensha', headers: admin })
    expect((byPublisher.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S2'])

    const byStatus = await app.inject({ method: 'GET', url: '/api/v1/series?status=ENDED', headers: admin })
    expect((byStatus.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S2'])

    const released = await app.inject({ method: 'GET', url: '/api/v1/series?release_year=1982', headers: admin })
    expect((released.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    const descending = await app.inject({
      method: 'GET',
      url: '/api/v1/series?sort=metadata.titleSort,desc',
      headers: admin,
    })
    expect(
      (descending.json() as { content: { metadata: { titleSort: string } }[] }).content.map(
        (s) => s.metadata.titleSort,
      ),
    ).toEqual(['Secret Series', 'Berserk', 'Akira'])

    const first = await app.inject({ method: 'GET', url: '/api/v1/series?page=0&size=2', headers: admin })
    const firstPage = first.json() as { content: { id: string }[]; totalElements: number; totalPages: number }
    expect(firstPage.content.map((s) => s.id)).toEqual(['S1', 'S2'])
    expect(firstPage.totalElements).toBe(3)
    expect(firstPage.totalPages).toBe(2)

    const second = await app.inject({ method: 'GET', url: '/api/v1/series?page=1&size=2', headers: admin })
    expect((second.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S3'])
    await app.close()
  })

  it('filters by read status and by full text search', async () => {
    const { app } = await setup()

    const inProgress = await app.inject({
      method: 'GET',
      url: '/api/v1/series?read_status=IN_PROGRESS',
      headers: reader,
    })
    expect((inProgress.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    const unread = await app.inject({ method: 'GET', url: '/api/v1/series?read_status=UNREAD', headers: reader })
    expect((unread.json() as { totalElements: number }).totalElements).toBe(0)

    const searched = await app.inject({ method: 'GET', url: '/api/v1/series?search=akira', headers: admin })
    expect((searched.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    const regex = await app.inject({ method: 'GET', url: '/api/v1/series?search_regex=%5Eber,title', headers: admin })
    expect((regex.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S2'])

    const badRegex = await app.inject({ method: 'GET', url: '/api/v1/series?search_regex=%5B,title', headers: admin })
    expect(badRegex.statusCode).toBe(400)
    await app.close()
  })

  it('supports the POST search endpoints', async () => {
    const { app } = await setup()

    const listed = await app.inject({
      method: 'POST',
      url: '/api/v1/series/list',
      headers: admin,
      payload: { fullTextSearch: 'berserk' },
    })
    expect((listed.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S2'])

    const groups = await app.inject({
      method: 'POST',
      url: '/api/v1/series/list/alphabetical-groups',
      headers: admin,
      payload: {},
    })
    expect((groups.json() as { group: string }[]).map((entry) => entry.group)).toEqual(['a', 'b', 's'])
    await app.close()
  })

  it('groups series alphabetically and lists release dates', async () => {
    const { app } = await setup()

    const groups = await app.inject({ method: 'GET', url: '/api/v1/series/alphabetical-groups', headers: admin })
    expect(groups.json()).toEqual([
      { group: 'a', count: 1 },
      { group: 'b', count: 1 },
      { group: 's', count: 1 },
    ])

    // The first character is the group whatever it is; a client decides which
    // characters are letters of its navigation.
    expect(['Élan', '  berserk', '20th Century Boys', 'がんばれ', '#DRCL', '𠮷野家', ''].map(groupOf)).toEqual([
      'e',
      'b',
      '2',
      'か',
      '#',
      '𠮷',
      '',
    ])

    const dates = await app.inject({ method: 'GET', url: '/api/v1/series/release-dates', headers: admin })
    expect(dates.json()).toEqual(['1982', '1985', '1989'])
    await app.close()
  })

  it('lists the collections a series belongs to', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/series/S1/collections', headers: reader })
    expect(res.statusCode).toBe(200)
    const collections = res.json() as { id: string; seriesIds: string[]; filtered: boolean }[]
    expect(collections).toHaveLength(1)
    const [collection] = collections
    expect(collection!.id).toBe('C1')
    expect(collection!.seriesIds).toEqual(['S1'])
    expect(collection!.filtered).toBe(false)
    await app.close()
  })

  it('returns the recent listings', async () => {
    const { app } = await setup()
    for (const path of ['latest', 'new', 'updated']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/series/${path}`, headers: reader })
      expect(res.statusCode, path).toBe(200)
      expect((res.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])
    }
    await app.close()
  })

  it('queues analysis and metadata refresh as jobs', async () => {
    const { app, database } = await setup()

    expect((await app.inject({ method: 'POST', url: '/api/v1/series/S1/analyze', headers: admin })).statusCode).toBe(
      202,
    )
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/series/S1/metadata/refresh', headers: admin })).statusCode,
    ).toBe(202)
    expect((await app.inject({ method: 'POST', url: '/api/v1/series/S1/analyze', headers: reader })).statusCode).toBe(
      403,
    )

    const jobs = await database.db.selectFrom('jobs').select(['type']).execute()
    // The series' books are refreshed with it - metadata and artwork both - and the
    // series' own folder is looked in for a cover, as the reference's endpoint does.
    expect(new Set(jobs.map((job) => job.type))).toEqual(
      new Set([
        'AnalyzeSeries',
        'RefreshSeriesMetadata',
        'RefreshSeriesLocalArtwork',
        'RefreshBookMetadata',
        'RefreshBookLocalArtwork',
      ]),
    )
    const books = await database.db.selectFrom('books').select('id').where('series_id', '=', 'S1').execute()
    expect(jobs.filter((job) => job.type === 'RefreshBookMetadata')).toHaveLength(books.length)
    await app.close()
  })
})

describe('series metadata', () => {
  it('writes values, locks and list fields', async () => {
    const { app } = await setup()

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      headers: admin,
      payload: {
        title: 'Akira Deluxe',
        titleLock: true,
        status: 'ENDED',
        ageRating: 16,
        readingDirection: 'RIGHT_TO_LEFT',
        totalBookCount: 3,
        tags: ['cyberpunk', 'classic'],
        genres: ['Science Fiction'],
        sharingLabels: [],
        links: [{ label: 'Wikipedia', url: 'https://example.org/akira' }],
        alternateTitles: [{ label: 'ja', title: 'アキラ' }],
        genresLock: true,
      },
    })
    expect(res.statusCode).toBe(204)

    const dto = (await app.inject({ method: 'GET', url: '/api/v1/series/S1', headers: admin })).json() as {
      metadata: Record<string, unknown>
    }

    expect(dto.metadata.title).toBe('Akira Deluxe')
    expect(dto.metadata.titleLock).toBe(true)
    expect(dto.metadata.status).toBe('ENDED')
    expect(dto.metadata.ageRating).toBe(16)
    expect(dto.metadata.readingDirection).toBe('RIGHT_TO_LEFT')
    expect(dto.metadata.totalBookCount).toBe(3)
    expect(dto.metadata.tags).toEqual(['classic', 'cyberpunk'])
    expect(dto.metadata.genresLock).toBe(true)
    expect(dto.metadata.sharingLabels).toEqual([])
    expect(dto.metadata.links).toEqual([{ label: 'Wikipedia', url: 'https://example.org/akira' }])
    expect(dto.metadata.alternateTitles).toEqual([{ label: 'ja', title: 'アキラ' }])
    await app.close()
  })

  it('leaves omitted fields alone and rejects invalid values', async () => {
    const { app } = await setup()

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      headers: admin,
      payload: { summary: 'Kept' },
    })
    const after = (await app.inject({ method: 'GET', url: '/api/v1/series/S1', headers: admin })).json() as {
      metadata: { summary: string; title: string }
    }
    expect(after.metadata.summary).toBe('Kept')
    expect(after.metadata.title).toBe('Akira')

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/series/S1/metadata',
      headers: admin,
      payload: { status: 'NONSENSE', ageRating: 'old' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(
      Object.keys((invalid.json() as { validationErrors: Record<string, string> }).validationErrors).sort(),
    ).toEqual(['ageRating', 'status'])

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/series/S1/metadata',
          headers: reader,
          payload: { title: 'Nope' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/series/NOPE/metadata',
          headers: admin,
          payload: { title: 'Nope' },
        })
      ).statusCode,
    ).toBe(404)
    await app.close()
  })
})

describe('series read progress', () => {
  it('marks a series read and unread again', async () => {
    const { app, database } = await setup()

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/series/S1/read-progress', headers: reader })).statusCode,
    ).toBe(204)

    const rows = await database.db
      .selectFrom('read_progress')
      .select(['book_id', 'completed'])
      .where('user_id', '=', 'U2')
      .orderBy('book_id')
      .execute()
    expect(rows).toEqual([
      { book_id: 'B1', completed: 1 },
      { book_id: 'B2', completed: 1 },
    ])

    const readStatus = await app.inject({ method: 'GET', url: '/api/v1/series?read_status=READ', headers: reader })
    expect((readStatus.json() as { content: { id: string }[] }).content.map((s) => s.id)).toEqual(['S1'])

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/series/S1/read-progress', headers: reader })).statusCode,
    ).toBe(204)
    const remaining = await database.db
      .selectFrom('read_progress')
      .select('book_id')
      .where('user_id', '=', 'U2')
      .execute()
    expect(remaining).toEqual([])
    await app.close()
  })
})

describe('search conditions', () => {
  it('filters a book list by the typed condition', async () => {
    const { app, database } = await setup()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: { condition: { title: { operator: 'is', value: 'Akira Volume One' } } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().content.map((entry: { id: string }) => entry.id)).toEqual(['B1'])
    expect(res.json().totalElements).toBe(1)

    const anyOf = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: {
        condition: {
          allOf: [
            { libraryId: { operator: 'is', value: 'L1' } },
            {
              anyOf: [
                { title: { operator: 'endsWith', value: 'Two' } },
                { mediaProfile: { operator: 'is', value: 'PDF' } },
              ],
            },
          ],
        },
      },
    })
    expect(
      anyOf
        .json()
        .content.map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(['B2', 'B3'])

    await database.close()
  })

  it('answers 400 for a condition it cannot translate', async () => {
    const { app, database } = await setup()

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: { condition: { nonsense: { operator: 'is', value: 'x' } } },
    })
    expect(unknownField.statusCode).toBe(400)
    expect(unknownField.json()).toEqual({ message: 'nonsense is not a field a book search knows' })

    const wrongOperator = await app.inject({
      method: 'POST',
      url: '/api/v1/series/list',
      headers: admin,
      payload: { condition: { title: { operator: 'greaterThan', value: 3 } } },
    })
    expect(wrongOperator.statusCode).toBe(400)
    expect(wrongOperator.json().message).toContain('does not take the operator greaterThan')

    const bookFieldOnASeries = await app.inject({
      method: 'POST',
      url: '/api/v1/series/list',
      headers: admin,
      payload: { condition: { mediaStatus: { operator: 'is', value: 'READY' } } },
    })
    expect(bookFieldOnASeries.statusCode).toBe(400)

    await database.close()
  })

  it('narrows a condition by what the caller may see, and by their read progress', async () => {
    const { app, database } = await setup()

    // The reader may only see one library, so a condition that asks for the other
    // one finds nothing rather than everything.
    const otherLibrary = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: reader,
      payload: { condition: { libraryId: { operator: 'is', value: 'L2' } } },
    })
    expect(otherLibrary.json().content).toEqual([])

    // Read status is the caller's own: the reader finished the first book, the
    // administrator has no progress at all.
    const condition = { condition: { readStatus: { operator: 'is', value: 'READ' } } }
    const forReader = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: reader,
      payload: condition,
    })
    expect(forReader.json().content.map((entry: { id: string }) => entry.id)).toEqual(['B1'])

    const forAdmin = await app.inject({ method: 'POST', url: '/api/v1/books/list', headers: admin, payload: condition })
    expect(forAdmin.json().content).toEqual([])

    await database.close()
  })

  it('filters a series list by the typed condition', async () => {
    const { app, database } = await setup()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/series/list',
      headers: admin,
      payload: {
        condition: {
          allOf: [{ libraryId: { operator: 'is', value: 'L1' } }, { tag: { operator: 'isNull' } }],
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S2'])

    await database.close()
  })
})

describe('full text search', () => {
  it('finds books and series by a word, and orders the books by relevance', async () => {
    const { app, database } = await setup()

    const books = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: { fullTextSearch: 'akira' },
    })
    expect(books.statusCode).toBe(200)
    expect(
      books
        .json()
        .content.map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(['B1', 'B2'])
    expect(books.json().totalElements).toBe(2)

    // The query parameter means the same thing as the body field.
    const byQuery = await app.inject({ method: 'GET', url: '/api/v1/books?search=berserk', headers: admin })
    expect(byQuery.json().content.map((entry: { id: string }) => entry.id)).toEqual(['B3'])

    // Relevance is the default order, and a caller may ask for it by name.
    const ordered = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: { fullTextSearch: 'akira' },
    })
    expect(ordered.json().content.map((entry: { id: string }) => entry.id)).toEqual(
      books.json().content.map((entry: { id: string }) => entry.id),
    )

    const byName = await app.inject({ method: 'GET', url: '/api/v1/series?search=akira', headers: admin })
    expect(byName.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S1'])

    await database.close()
  })

  it('stems, and asks for every word', async () => {
    const { app, database } = await setup()

    // The stored titles all say "Volume": the plural finds every one of them, which is
    // the stemming the reference's analyser does too.
    const plural = await app.inject({ method: 'GET', url: '/api/v1/books?search=volumes', headers: admin })
    expect(
      plural
        .json()
        .content.map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(['B1', 'B2', 'B3'])

    // A trailing star is a prefix, as it is in the search language the reference parses.
    const prefix = await app.inject({ method: 'GET', url: '/api/v1/books?search=akir*', headers: admin })
    expect(
      prefix
        .json()
        .content.map((entry: { id: string }) => entry.id)
        .sort(),
    ).toEqual(['B1', 'B2'])

    const both = await app.inject({
      method: 'POST',
      url: '/api/v1/books/list',
      headers: admin,
      payload: { fullTextSearch: 'akira two' },
    })
    expect(both.json().content.map((entry: { id: string }) => entry.id)).toEqual(['B2'])

    await database.close()
  })

  it('answers with nothing, rather than with everything, for a term it cannot use', async () => {
    const { app, database } = await setup()

    // A search box can produce any of these, and none of them may be an error or an
    // unfiltered list.
    for (const term of ['"', '!!!', '-', 'NEAR(']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/books?search=${encodeURIComponent(term)}`,
        headers: admin,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().content).toEqual([])
    }

    const missing = await app.inject({ method: 'GET', url: '/api/v1/books?search=nothingatall', headers: admin })
    expect(missing.json().content).toEqual([])

    await database.close()
  })

  it('finds collections and read lists by name', async () => {
    const { app, database } = await setup()

    const collections = await app.inject({ method: 'GET', url: '/api/v1/collections?search=classics', headers: admin })
    expect(collections.json().content.map((entry: { id: string }) => entry.id)).toEqual(['C1'])

    const none = await app.inject({ method: 'GET', url: '/api/v1/collections?search=akira', headers: admin })
    expect(none.json().content).toEqual([])
    expect(none.json().totalElements).toBe(0)

    const readLists = await app.inject({ method: 'GET', url: '/api/v1/readlists?search=favourites', headers: admin })
    expect(readLists.json().content.map((entry: { id: string }) => entry.id)).toEqual(['RL1'])

    await database.close()
  })

  it('searches a series by regular expression in the field it names', async () => {
    const { app, database } = await setup()

    const byTitle = await app.inject({
      method: 'GET',
      url: `/api/v1/series?search_regex=${encodeURIComponent('^Ak,title')}`,
      headers: admin,
    })
    expect(byTitle.statusCode).toBe(200)
    expect(byTitle.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S1'])

    const byTitleSort = await app.inject({
      method: 'GET',
      url: `/api/v1/series?search_regex=${encodeURIComponent('^Berserk,title_sort')}`,
      headers: admin,
    })
    expect(byTitleSort.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S2'])

    const caseInsensitiveField = await app.inject({
      method: 'GET',
      url: `/api/v1/series?search_regex=${encodeURIComponent('^Ak,TITLE')}`,
      headers: admin,
    })
    expect(caseInsensitiveField.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S1'])

    // A value without a field at all is read as a pattern for the title, which is how
    // this server read it before it read fields.
    const withoutField = await app.inject({
      method: 'GET',
      url: `/api/v1/series?search_regex=${encodeURIComponent('^Ak')}`,
      headers: admin,
    })
    expect(withoutField.json().content.map((entry: { id: string }) => entry.id)).toEqual(['S1'])

    // A value naming a field that is not one is dropped rather than refused, which is
    // what the reference does with it.
    for (const value of ['^Ak,author', '^Ak,']) {
      const ignored = await app.inject({
        method: 'GET',
        url: `/api/v1/series?search_regex=${encodeURIComponent(value)}`,
        headers: admin,
      })
      expect(ignored.statusCode).toBe(200)
      expect(ignored.json().content.length).toBe(3)
    }

    // A pattern that is not a regular expression is a 400, as before.
    const invalid = await app.inject({
      method: 'GET',
      url: `/api/v1/series?search_regex=${encodeURIComponent('[,title')}`,
      headers: admin,
    })
    expect(invalid.statusCode).toBe(400)

    await database.close()
  })
})

describe('books', () => {
  it('returns pages of books scoped to the caller', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: reader })
    expect(res.statusCode).toBe(200)
    const page = res.json() as { content: Record<string, unknown>[]; totalElements: number }
    expect(page.totalElements).toBe(2)

    const dto = page.content[0]!
    for (const key of [
      'id',
      'seriesId',
      'seriesTitle',
      'libraryId',
      'name',
      'url',
      'number',
      'oneshot',
      'deleted',
      'created',
      'lastModified',
      'fileLastModified',
      'fileHash',
      'size',
      'sizeBytes',
      'media',
      'metadata',
    ]) {
      expect(dto, `missing ${key}`).toHaveProperty(key)
    }
    expect(dto.seriesTitle).toBe('Akira')
    expect(dto.sizeBytes).toBe(1024)
    expect(dto.size).toBe('1 KB')
    expect((dto.media as Record<string, unknown>).mediaProfile).toBe('DIVINA')
    expect((dto.media as Record<string, unknown>).pagesCount).toBe(200)
    expect((dto.metadata as Record<string, unknown>).tags).toEqual(['classic'])
    expect((dto.readProgress as Record<string, unknown>).completed).toBe(true)
    await app.close()
  })

  it('filters by read status and tag, and returns everything when unpaged', async () => {
    const { app } = await setup()

    const read = await app.inject({ method: 'GET', url: '/api/v1/books?read_status=READ', headers: reader })
    expect((read.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B1'])

    const unread = await app.inject({ method: 'GET', url: '/api/v1/books?read_status=UNREAD', headers: reader })
    expect((unread.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B2'])

    const tagged = await app.inject({ method: 'GET', url: '/api/v1/books?tag=classic', headers: reader })
    expect((tagged.json() as { totalElements: number }).totalElements).toBe(1)

    const unpaged = await app.inject({ method: 'GET', url: '/api/v1/books?unpaged=true', headers: reader })
    // Unpaged is about paging: both of the reader's books come back, pages or none.
    expect((unpaged.json() as { content: { id: string }[] }).content.map((b) => b.id).sort()).toEqual(['B1', 'B2'])

    const released = await app.inject({
      method: 'GET',
      url: '/api/v1/books?released_after=1983-01-01',
      headers: admin,
    })
    expect((released.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B3', 'B2'])
    await app.close()
  })

  it('lists books of one series, latest books and duplicates', async () => {
    const { app } = await setup()

    const seriesBooks = await app.inject({ method: 'GET', url: '/api/v1/series/S1/books', headers: reader })
    expect((seriesBooks.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B1', 'B2'])

    const latest = await app.inject({ method: 'GET', url: '/api/v1/books/latest', headers: reader })
    expect((latest.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B2', 'B1'])

    const duplicates = await app.inject({ method: 'GET', url: '/api/v1/books/duplicates', headers: reader })
    expect((duplicates.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B1', 'B2'])
    await app.close()
  })

  it('sorts books by the names the reference gives its sorts', async () => {
    const { app, database } = await setup()
    const ids = async (sort: string, headers = admin) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/books/list?sort=${sort}`,
        headers,
        payload: {},
      })
      expect(response.statusCode).toBe(200)
      return (response.json() as { content: { id: string }[] }).content.map((book) => book.id)
    }

    // Both spellings of the same thing, in both directions.
    expect(await ids('createdDate,desc')).toEqual(['B3', 'B2', 'B1'])
    expect(await ids('created,asc')).toEqual(['B1', 'B2', 'B3'])
    expect(await ids('fileSize,desc')).toEqual(['B3', 'B2', 'B1'])
    expect(await ids('size,asc')).toEqual(['B1', 'B2', 'B3'])

    // What the media says about a book.
    const now = new Date().toISOString()
    await database.db.deleteFrom('media').execute()
    await database.db
      .insertInto('media')
      .values([
        {
          book_id: 'B1',
          status: 'READY',
          media_type: 'application/zip',
          page_count: 30,
          created_date: now,
          last_modified_date: now,
        },
        {
          book_id: 'B2',
          status: 'ERROR',
          media_type: 'application/pdf',
          page_count: 0,
          created_date: now,
          last_modified_date: now,
        },
        {
          book_id: 'B3',
          status: 'UNSUPPORTED',
          media_type: 'application/x-rar',
          page_count: 10,
          created_date: now,
          last_modified_date: now,
        },
      ])
      .execute()
    expect(await ids('media.status,asc')).toEqual(['B2', 'B1', 'B3'])
    expect(await ids('media.pagesCount,desc')).toEqual(['B1', 'B3', 'B2'])
    expect(await ids('media.mediaType,asc')).toEqual(['B2', 'B3', 'B1'])

    // When the caller last read each book: theirs, not somebody else's.
    await database.db.deleteFrom('read_progress').execute()
    await database.db
      .insertInto('read_progress')
      .values([
        {
          user_id: 'U2',
          book_id: 'B1',
          page: 1,
          completed: 0,
          read_date: '2024-05-01T00:00:00.000Z',
          created_date: now,
          last_modified_date: now,
        },
        {
          user_id: 'U2',
          book_id: 'B2',
          page: 1,
          completed: 0,
          read_date: '2024-06-01T00:00:00.000Z',
          created_date: now,
          last_modified_date: now,
        },
        {
          user_id: 'U1',
          book_id: 'B1',
          page: 1,
          completed: 0,
          read_date: '2024-07-01T00:00:00.000Z',
          created_date: now,
          last_modified_date: now,
        },
      ])
      .execute()
    expect((await ids('readProgress.readDate,desc', reader)).slice(0, 2)).toEqual(['B2', 'B1'])
    expect((await ids('readProgress.readDate,desc')).at(0)).toBe('B1')

    await app.close()
  })

  it('sorts series by the names the reference gives its sorts', async () => {
    const { app, database } = await setup()
    const ids = async (sort: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/series/list?sort=${sort}`,
        headers: admin,
        payload: {},
      })
      expect(response.statusCode).toBe(200)
      // The two series of the main library; the administrator sees others besides.
      return (response.json() as { content: { id: string }[] }).content
        .map((series) => series.id)
        .filter((id) => id === 'S1' || id === 'S2')
    }

    await database.db
      .updateTable('series')
      .set({ created_date: '2023-01-01T00:00:00.000Z', book_count: 2 })
      .where('id', '=', 'S1')
      .execute()
    await database.db
      .updateTable('series')
      .set({ created_date: '2023-06-01T00:00:00.000Z', book_count: 1 })
      .where('id', '=', 'S2')
      .execute()

    expect(await ids('createdDate,desc')).toEqual(['S2', 'S1'])
    expect(await ids('created,asc')).toEqual(['S1', 'S2'])
    expect(await ids('booksCount,desc')).toEqual(['S1', 'S2'])
    expect(await ids('booksCount,asc')).toEqual(['S2', 'S1'])

    // The administrator reads a book of the second series and none of the first.
    const now = new Date().toISOString()
    await database.db
      .insertInto('read_progress')
      .values({
        user_id: 'U1',
        book_id: 'B3',
        page: 1,
        completed: 0,
        read_date: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    expect(await ids('readDate,desc')).toEqual(['S2', 'S1'])

    // A random order is still every series, once each.
    expect((await ids('random')).sort()).toEqual(['S1', 'S2'])

    await app.close()
  })

  it('suggests the next book to read', async () => {
    const { app } = await setup()
    const ondeck = await app.inject({ method: 'GET', url: '/api/v1/books/ondeck', headers: reader })
    expect((ondeck.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B2'])
    await app.close()
  })

  it('does not suggest a book of a series the reader is in the middle of', async () => {
    const { app, database } = await setup()

    // Opening the suggested book puts it under "keep reading", and the series
    // has nothing left to suggest until it is finished.
    const now = new Date().toISOString()
    await database.db
      .insertInto('read_progress')
      .values({
        user_id: 'U2',
        book_id: 'B2',
        page: 3,
        completed: 0,
        read_date: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    const ondeck = await app.inject({ method: 'GET', url: '/api/v1/books/ondeck', headers: reader })
    expect((ondeck.json() as { content: unknown[]; totalElements: number }).totalElements).toBe(0)
    await app.close()
  })

  it('suggests by the number a book is sorted under, not the one its file was found with', async () => {
    const { app, database } = await setup()

    // A third book whose metadata puts it before the second.
    const now = new Date().toISOString()
    await database.db
      .insertInto('books')
      .values({
        id: 'B9',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1.5',
        url: 'v1-5.cbz',
        file_last_modified: now,
        file_size: 10,
        number: 9,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await database.db
      .insertInto('book_metadata')
      .values({
        book_id: 'B9',
        title: 'Volume 1.5',
        number: '1.5',
        number_sort: 1.5,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    const ondeck = await app.inject({ method: 'GET', url: '/api/v1/books/ondeck', headers: reader })
    expect((ondeck.json() as { content: { id: string }[] }).content.map((b) => b.id)).toEqual(['B9'])
    await app.close()
  })

  it('walks to the next and previous book of a series', async () => {
    const { app } = await setup()

    const next = await app.inject({ method: 'GET', url: '/api/v1/books/B1/next', headers: reader })
    expect((next.json() as { id: string }).id).toBe('B2')
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B2/next', headers: reader })).statusCode).toBe(404)

    const previous = await app.inject({ method: 'GET', url: '/api/v1/books/B2/previous', headers: reader })
    expect((previous.json() as { id: string }).id).toBe('B1')
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/previous', headers: reader })).statusCode).toBe(
      404,
    )
    await app.close()
  })

  it('lists the read lists a book appears in', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/readlists', headers: reader })
    const lists = res.json() as { id: string; bookIds: string[] }[]
    expect(lists).toHaveLength(1)
    const [list] = lists
    expect(list!.id).toBe('RL1')
    expect(list!.bookIds).toEqual(['B1'])
    await app.close()
  })

  it('stores and returns reading progression', async () => {
    const { app } = await setup()

    const before = await app.inject({ method: 'GET', url: '/api/v1/books/B2/progression', headers: reader })
    expect(before.statusCode).toBe(200)
    const start = before.json() as { locator: { href: string } }
    expect(start.locator.href).toBe('/B2')

    const locator = { href: '/B2#page=7', type: 'image/png', locations: { position: 7, progression: 0.35 } }
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/books/B2/progression',
      headers: reader,
      payload: { device: { id: 'device-1', name: 'Phone' }, locator },
    })
    expect(put.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: '/api/v1/books/B2/progression', headers: reader })
    const progression = after.json() as { device: { id: string; name: string }; locator: Record<string, unknown> }
    expect(progression.device).toEqual({ id: 'device-1', name: 'Phone' })
    expect(progression.locator).toEqual(locator)
    await app.close()
  })

  // B1 has 200 pages, and the administrator has not opened it.
  const progressOf = async (database: Database) =>
    database.db
      .selectFrom('read_progress')
      .select(['page', 'completed', 'read_date'])
      .where('book_id', '=', 'B1')
      .where('user_id', '=', 'U1')
      .executeTakeFirst()
  const mark = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/v1/books/B1/read-progress', headers: admin, payload })

  it('records the page a reader is on, and that they have read today', async () => {
    const { app, database } = await setup()

    expect((await mark(app, { page: 12 })).statusCode).toBe(204)

    const row = await progressOf(database)
    expect(row).toMatchObject({ page: 12, completed: 0 })
    expect(row?.read_date).not.toBeNull()
    await app.close()
  })

  it('completes the book when its last page is reached, without being told', async () => {
    const { app, database } = await setup()

    expect((await mark(app, { page: 200 })).statusCode).toBe(204)
    expect(await progressOf(database)).toMatchObject({ page: 200, completed: 1 })

    // Going back a page is reading it again: it is no longer finished.
    expect((await mark(app, { page: 199 })).statusCode).toBe(204)
    expect(await progressOf(database)).toMatchObject({ page: 199, completed: 0 })
    await app.close()
  })

  it('puts a book marked as read at its last page, whatever page came with it', async () => {
    const { app, database } = await setup()

    expect((await mark(app, { completed: true })).statusCode).toBe(204)
    expect(await progressOf(database)).toMatchObject({ page: 200, completed: 1 })

    await mark(app, { page: 12 })
    expect((await mark(app, { page: 3, completed: true })).statusCode).toBe(204)
    expect(await progressOf(database)).toMatchObject({ page: 200, completed: 1 })
    await app.close()
  })

  it('refuses a page the book does not have, and a mark that names no page', async () => {
    const { app, database } = await setup()

    for (const payload of [{ page: 0 }, { page: 201 }, { page: -1 }, { page: 1.5 }, {}, { completed: false }]) {
      const res = await mark(app, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(await progressOf(database)).toBeUndefined()

    // B2 has not been analysed into pages, so no page of it can be the one being read.
    const pageless = await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B2/read-progress',
      headers: admin,
      payload: { page: 1 },
    })
    expect(pageless.statusCode).toBe(400)
    await app.close()
  })

  it('clears read progress', async () => {
    const { app, database } = await setup()
    await mark(app, { page: 12 })

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/read-progress', headers: admin })).statusCode,
    ).toBe(204)
    expect(await progressOf(database)).toBeUndefined()
    await app.close()
  })

  it('updates metadata singly and in bulk', async () => {
    const { app } = await setup()

    const single = await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B1/metadata',
      headers: admin,
      payload: { title: 'Akira v1', authorsLock: true, authors: [{ name: 'Otomo', role: 'writer' }] },
    })
    expect(single.statusCode).toBe(204)

    const bulk = await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/metadata',
      headers: admin,
      payload: { B2: { title: 'Akira v2', tags: ['reprint'] } },
    })
    expect(bulk.statusCode).toBe(200)

    const first = (await app.inject({ method: 'GET', url: '/api/v1/books/B1', headers: admin })).json() as {
      metadata: Record<string, unknown>
    }
    expect(first.metadata.title).toBe('Akira v1')
    expect(first.metadata.authorsLock).toBe(true)
    expect(first.metadata.authors).toEqual([{ name: 'Otomo', role: 'writer' }])

    const second = (await app.inject({ method: 'GET', url: '/api/v1/books/B2', headers: admin })).json() as {
      metadata: Record<string, unknown>
    }
    expect(second.metadata.title).toBe('Akira v2')
    expect(second.metadata.tags).toEqual(['reprint'])

    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/metadata',
      headers: admin,
      payload: { NOPE: { title: 'x' } },
    })
    expect(unknown.statusCode).toBe(400)

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/books/B1/metadata',
          headers: reader,
          payload: { title: 'no' },
        })
      ).statusCode,
    ).toBe(403)
    await app.close()
  })

  it('queues book analysis as a job', async () => {
    const { app, database } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/v1/books/B1/analyze', headers: admin })).statusCode).toBe(202)
    const jobs = await database.db.selectFrom('jobs').select(['type', 'unique_key']).execute()
    expect(jobs).toEqual([{ type: 'AnalyzeBook', unique_key: 'ANALYZE_BOOK_B1' }])
    await app.close()
  })

  it('forbids access to books the caller cannot see', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B3', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/NOPE', headers: reader })).statusCode).toBe(404)
    await app.close()
  })
})
