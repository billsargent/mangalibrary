import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

/**
 * The lists a filter is picked from, asked the way the filter panels ask.
 *
 * Two libraries, of which the reader sees one, and in it one series they are too
 * young for:
 *
 *   L1  S1 Akira    age 12  tag cyberpunk     books B1 (classic), B2 (colour)
 *       S2 Berserk  age 18  tag dark fantasy  book  B3 (gore)
 *   L2  S3 Secret           tag hidden        book  B4 (buried)
 *
 * S2 is in collection C1, and B2 is on read list R1.
 */

const admin = { 'x-api-key': 'admin-api-key' }
const reader = { 'x-api-key': 'reader-api-key' }
const now = '2026-01-01T00:00:00.000Z'
const dates = { created_date: now, last_modified_date: now }

async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-referential-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db

  await db
    .insertInto('users')
    .values([
      {
        id: 'U1',
        email: 'admin@example.com',
        password: 'unused: these tests sign in by key',
        roles: JSON.stringify(['ADMIN']),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        ...dates,
      },
      {
        id: 'U2',
        email: 'reader@example.com',
        password: 'unused: these tests sign in by key',
        roles: JSON.stringify(['PAGE_STREAMING']),
        shared_all_libraries: 0,
        age_restriction: 12,
        age_restriction_allow_only: 1,
        ...dates,
      },
    ])
    .execute()
  await db
    .insertInto('user_api_keys')
    .values([
      { id: 'K1', user_id: 'U1', key: admin['x-api-key'], comment: 'admin', ...dates },
      { id: 'K2', user_id: 'U2', key: reader['x-api-key'], comment: 'reader', ...dates },
    ])
    .execute()
  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root: '/library', ...dates },
      { id: 'L2', name: 'Secret', root: '/secret', ...dates },
    ])
    .execute()
  await db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

  const series = [
    { id: 'S1', library: 'L1', name: 'Akira', age: 12, publisher: 'Kodansha', language: 'en', released: '1982-12-20' },
    {
      id: 'S2',
      library: 'L1',
      name: 'Berserk',
      age: 18,
      publisher: 'Hakusensha',
      language: 'ja',
      released: '1989-08-25',
    },
    { id: 'S3', library: 'L2', name: 'Secret', age: null, publisher: 'Nobody', language: 'fr', released: '2001-01-01' },
  ]
  for (const row of series) {
    await db
      .insertInto('series')
      .values({
        id: row.id,
        library_id: row.library,
        name: row.name,
        url: row.name.toLowerCase(),
        file_last_modified: now,
        ...dates,
      })
      .execute()
    await db
      .insertInto('series_metadata')
      .values({
        series_id: row.id,
        title: row.name,
        title_sort: row.name,
        publisher: row.publisher,
        language: row.language,
        age_rating: row.age,
        ...dates,
      })
      .execute()
    await db
      .insertInto('book_metadata_aggregation')
      .values({ series_id: row.id, release_date: row.released, ...dates })
      .execute()
  }
  await db
    .insertInto('series_metadata_tag')
    .values([
      { series_id: 'S1', tag: 'cyberpunk' },
      { series_id: 'S2', tag: 'dark fantasy' },
      { series_id: 'S3', tag: 'hidden' },
    ])
    .execute()
  await db
    .insertInto('series_metadata_genre')
    .values([
      { series_id: 'S1', genre: 'Science Fiction' },
      { series_id: 'S2', genre: 'Fantasy' },
      { series_id: 'S3', genre: 'Mystery' },
    ])
    .execute()
  await db
    .insertInto('series_metadata_sharing')
    .values([
      { series_id: 'S1', label: 'kids' },
      { series_id: 'S2', label: 'mature' },
    ])
    .execute()

  const books = [
    { id: 'B1', series: 'S1', library: 'L1', tag: 'classic', author: 'Katsuhiro Otomo', role: 'writer' },
    { id: 'B2', series: 'S1', library: 'L1', tag: 'colour', author: 'Steve Oliff', role: 'colorist' },
    { id: 'B3', series: 'S2', library: 'L1', tag: 'gore', author: 'Kentaro Miura', role: 'writer' },
    { id: 'B4', series: 'S3', library: 'L2', tag: 'buried', author: 'Anonymous', role: 'editor' },
  ]
  for (const row of books) {
    await db
      .insertInto('books')
      .values({
        id: row.id,
        series_id: row.series,
        library_id: row.library,
        name: row.id,
        url: `${row.id}.cbz`,
        file_last_modified: now,
        ...dates,
      })
      .execute()
    await db
      .insertInto('book_metadata')
      .values({ book_id: row.id, title: row.id, ...dates })
      .execute()
    await db.insertInto('book_metadata_tag').values({ book_id: row.id, tag: row.tag }).execute()
    await db.insertInto('book_metadata_author').values({ book_id: row.id, name: row.author, role: row.role }).execute()
  }

  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Dark', ...dates })
    .execute()
  await db.insertInto('collection_series').values({ collection_id: 'C1', series_id: 'S2' }).execute()
  await db
    .insertInto('readlists')
    .values({ id: 'R1', name: 'Colour', ...dates })
    .execute()
  await db.insertInto('readlist_book').values({ readlist_id: 'R1', book_id: 'B2' }).execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

interface Page<T> {
  content: T[]
  totalElements: number
  number: number
  size: number
  last: boolean
}

const asker =
  (app: FastifyInstance, headers: Record<string, string>) =>
  async <T = string>(url: string): Promise<Page<T>> => {
    const res = await app.inject({ method: 'GET', url: `/api/v2/${url}`, headers })
    expect([url, res.statusCode]).toEqual([url, 200])
    return res.json() as Page<T>
  }

describe('tags to filter by', () => {
  it('are the series tags and the book tags, unless one kind is asked for', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    const every = ['buried', 'classic', 'colour', 'cyberpunk', 'dark fantasy', 'gore', 'hidden']
    expect((await ask('tags')).content).toEqual(every)
    expect((await ask('tags?include=BOTH')).content).toEqual(every)
    expect((await ask('tags?include=SERIES')).content).toEqual(['cyberpunk', 'dark fantasy', 'hidden'])
    expect((await ask('tags?include=BOOK')).content).toEqual(['buried', 'classic', 'colour', 'gore'])
    await app.close()
  })

  it('are those of where the panel is open', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    expect((await ask('tags?library_id=L1')).content).toEqual([
      'classic',
      'colour',
      'cyberpunk',
      'dark fantasy',
      'gore',
    ])
    expect((await ask('tags?library_id=L2')).content).toEqual(['buried', 'hidden'])
    expect((await ask('tags?library_id=L1&library_id=L2')).totalElements).toBe(7)
    expect((await ask('tags?collection_id=C1')).content).toEqual(['dark fantasy', 'gore'])
    expect((await ask('tags?series_id=S1')).content).toEqual(['classic', 'colour', 'cyberpunk'])
    expect((await ask('tags?series_id=S1&include=BOOK')).content).toEqual(['classic', 'colour'])
    // A read list is of books: theirs, and the tags of the series they are from.
    expect((await ask('tags?readlist_id=R1')).content).toEqual(['colour', 'cyberpunk'])
    expect((await ask('tags?readlist_id=R1&include=BOOK')).content).toEqual(['colour'])
    expect((await ask('tags?library_id=nowhere')).content).toEqual([])
    await app.close()
  })

  it('can be searched, whatever the case, and a wildcard is only a character', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    expect((await ask('tags?search=CY')).content).toEqual(['cyberpunk'])
    expect((await ask('tags?search=o')).content).toEqual(['colour', 'gore'])
    expect((await ask('tags?search=o&library_id=L1&include=BOOK')).content).toEqual(['colour', 'gore'])
    expect((await ask('tags?search=%25')).content).toEqual([])
    await app.close()
  })

  it('come a page at a time, or all at once', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    const second = await ask('tags?page=1&size=3')
    expect(second.content).toEqual(['cyberpunk', 'dark fantasy', 'gore'])
    expect([second.number, second.size, second.totalElements, second.last]).toEqual([1, 3, 7, false])
    const third = await ask('tags?page=2&size=3')
    expect([third.content, third.last]).toEqual([['hidden'], true])

    // Twenty to a page unless told; `unpaged` is everything.
    const many = await setup()
    await many.database.db
      .insertInto('series_metadata_tag')
      .values(
        Array.from({ length: 30 }, (_, index) => ({ series_id: 'S1', tag: `t${String(index).padStart(2, '0')}` })),
      )
      .execute()
    const askMany = asker(many.app, admin)
    expect((await askMany('tags')).content).toHaveLength(20)
    expect((await askMany('tags?unpaged=true')).content).toHaveLength(37)
    await many.app.close()
    await app.close()
  })
})

describe('a reader who sees one library, and not everything in it', () => {
  it('is offered only what is in the series they can open', async () => {
    const { app } = await setup()
    const ask = asker(app, reader)

    expect((await ask('tags')).content).toEqual(['classic', 'colour', 'cyberpunk'])
    expect((await ask('tags?library_id=L2')).content).toEqual([])
    expect((await ask('tags?collection_id=C1')).content).toEqual([])
    expect((await ask('genres')).content).toEqual(['Science Fiction'])
    expect((await ask('publishers')).content).toEqual(['Kodansha'])
    expect((await ask('languages')).content).toEqual(['en'])
    expect((await ask('sharing-labels')).content).toEqual(['kids'])
    expect((await ask('authors/names')).content).toEqual(['Katsuhiro Otomo', 'Steve Oliff'])
    expect((await ask<number>('age-ratings')).content).toEqual([12])
    expect((await ask('series/release-years')).content).toEqual(['1982'])
    await app.close()
  })
})

describe('the other lists', () => {
  it('are scoped and searched the same way', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    expect((await ask('genres')).content).toEqual(['Fantasy', 'Mystery', 'Science Fiction'])
    expect((await ask('genres?library_id=L1')).content).toEqual(['Fantasy', 'Science Fiction'])
    expect((await ask('genres?collection_id=C1')).content).toEqual(['Fantasy'])
    expect((await ask('genres?search=fi')).content).toEqual(['Science Fiction'])
    expect((await ask('publishers?library_id=L1&search=sha')).content).toEqual(['Hakusensha', 'Kodansha'])
    expect((await ask('languages?library_id=L2')).content).toEqual(['fr'])
    expect((await ask('sharing-labels?collection_id=C1')).content).toEqual(['mature'])

    // Ratings lowest first, as numbers; years newest first.
    expect((await ask<number>('age-ratings')).content).toEqual([12, 18])
    expect((await ask<number>('age-ratings?collection_id=C1')).content).toEqual([18])
    expect((await ask('series/release-years')).content).toEqual(['2001', '1989', '1982'])
    expect((await ask('series/release-years?library_id=L1')).content).toEqual(['1989', '1982'])
    await app.close()
  })

  it('name who made what, by name, by role and by where', async () => {
    const { app } = await setup()
    const ask = asker(app, admin)

    expect((await ask<{ name: string; role: string }>('authors?library_id=L1&role=writer')).content).toEqual([
      { name: 'Katsuhiro Otomo', role: 'writer' },
      { name: 'Kentaro Miura', role: 'writer' },
    ])
    expect((await ask('authors/names?search=MIURA')).content).toEqual(['Kentaro Miura'])
    expect((await ask('authors/names?series_id=S1')).content).toEqual(['Katsuhiro Otomo', 'Steve Oliff'])
    expect((await ask('authors/names?readlist_id=R1')).content).toEqual(['Steve Oliff'])
    expect((await ask('authors/roles')).content).toEqual(['colorist', 'editor', 'writer'])
    expect((await ask('authors/roles?library_id=L2')).content).toEqual(['editor'])
    await app.close()
  })

  it('answer the older API as plain lists', async () => {
    const { app } = await setup()
    const get = async (url: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/${url}`, headers: admin })).json()

    expect(await get('tags?library_id=L2')).toEqual(['buried', 'hidden'])
    expect(await get('tags/series?library_id=L2')).toEqual(['hidden'])
    expect(await get('tags/book?series_id=S1')).toEqual(['classic', 'colour'])
    expect(await get('age-ratings')).toEqual(['12', '18'])
    expect(await get('series/release-dates?library_id=L1')).toEqual(['1989', '1982'])
    await app.close()
  })
})

describe('a library with more series than a query has parameters', () => {
  it('still answers, for a reader whose series are counted out one by one', async () => {
    const { app, database } = await setup()
    // 33,000 series the reader may open: more than the 32,766 values SQLite will bind.
    await sql`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 33000)
      insert into series (id, library_id, name, url, file_last_modified, created_date, last_modified_date)
      select 'X' || i, 'L1', 'x' || i, 'x' || i, ${now}, ${now}, ${now} from n
    `.execute(database.db)
    await sql`
      insert into series_metadata (series_id, title, title_sort, age_rating, created_date, last_modified_date)
      select id, name, name, 10, ${now}, ${now} from series where id like 'X%'
    `.execute(database.db)
    await sql`update content_version set version = version + 1`.execute(database.db)
    await database.db.insertInto('series_metadata_tag').values({ series_id: 'X33000', tag: 'far away' }).execute()

    expect((await asker(app, reader)('tags')).content).toEqual(['classic', 'colour', 'cyberpunk', 'far away'])
    expect((await asker(app, admin)('tags?library_id=L1&include=SERIES')).content).toEqual([
      'cyberpunk',
      'dark fantasy',
      'far away',
    ])
    await app.close()
  })
})
