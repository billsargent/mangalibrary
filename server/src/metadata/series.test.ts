import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { writeZip } from '../testing/zip.js'
import { refreshBookMetadata } from './refresh.js'
import { refreshSeriesMetadata } from './series.js'

const PAGE = Buffer.from('a page')

function comicInfo(fields: Record<string, string>): string {
  const elements = Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join('')
  return `<ComicInfo>${elements}</ComicInfo>`
}

interface BookSpec {
  name: string
  /** The document to put in the book; null or absent leaves the book without one. */
  document?: string | null
  /** Write a file that is not a container at all. */
  broken?: boolean
  metadata?: { number?: string; summary?: string; releaseDate?: string | null }
}

async function setup(books: readonly BookSpec[], library: Record<string, unknown> = {}): Promise<Database> {
  const root = mkdtempSync(join(tmpdir(), 'ml-series-'))
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now, ...library } as never)
    .execute()
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
    .values({ series_id: 'S1', title: 'Akira', title_sort: 'Akira', created_date: now, last_modified_date: now })
    .execute()

  for (const [index, book] of books.entries()) {
    const path = join(root, `${book.name}.cbz`)
    if (book.broken === true) {
      writeFileSync(path, Buffer.from('this is not a container'))
    } else {
      const entries = [{ name: 'page1.jpg', data: PAGE }]
      if (book.document !== null && book.document !== undefined) {
        entries.push({ name: 'ComicInfo.xml', data: Buffer.from(book.document, 'utf8') })
      }
      writeFileSync(path, writeZip(entries))
    }

    const id = `B${index + 1}`
    await database.db
      .insertInto('books')
      .values({
        id,
        series_id: 'S1',
        library_id: 'L1',
        name: book.name,
        url: pathToFileURL(path).href,
        file_last_modified: now,
        number: index + 1,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await database.db
      .insertInto('book_metadata')
      .values({
        book_id: id,
        title: book.metadata?.number === undefined ? book.name : book.name,
        number: book.metadata?.number ?? String(index + 1),
        number_sort: Number(book.metadata?.number ?? index + 1),
        summary: book.metadata?.summary ?? '',
        release_date: book.metadata?.releaseDate ?? null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
  }

  return database
}

async function seriesMetadata(database: Database) {
  return database.db.selectFrom('series_metadata').selectAll().where('series_id', '=', 'S1').executeTakeFirstOrThrow()
}

async function genres(database: Database) {
  return database.db
    .selectFrom('series_metadata_genre')
    .select('genre')
    .where('series_id', '=', 'S1')
    .orderBy('genre')
    .execute()
}

async function aggregation(database: Database) {
  return database.db
    .selectFrom('book_metadata_aggregation')
    .selectAll()
    .where('series_id', '=', 'S1')
    .executeTakeFirst()
}

describe('refreshing a series from its books', () => {
  it('takes what the books say about the series', async () => {
    const database = await setup([
      {
        name: 'Volume 1',
        document: comicInfo({
          Series: 'Akira Deluxe',
          Publisher: 'Kodansha',
          Genre: 'Science Fiction, Action',
          LanguageISO: 'en-US',
          AgeRating: 'Teen',
          Manga: 'No',
          Count: '6',
          Year: '1984',
          Month: '12',
          Day: '6',
          Writer: 'Katsuhiro Otomo',
          Tags: 'Cyberpunk',
          Summary: 'Neo-Tokyo.',
        }),
      },
    ])

    const result = await refreshSeriesMetadata(database.db, 'S1')
    expect(result.status).toBe('changed')
    expect(result.changed.sort()).toEqual(
      [
        'ageRating',
        'genres',
        'language',
        'publisher',
        'readingDirection',
        'title',
        'titleSort',
        'totalBookCount',
      ].sort(),
    )

    const row = await seriesMetadata(database)
    expect(row.title).toBe('Akira Deluxe')
    expect(row.publisher).toBe('Kodansha')
    expect(row.language).toBe('en-US')
    expect(row.age_rating).toBe(13)
    expect(row.reading_direction).toBe('LEFT_TO_RIGHT')
    expect(row.total_book_count).toBe(6)
    expect((await genres(database)).map((genre) => genre.genre)).toEqual(['Action', 'Science Fiction'])
  })

  it('fills the aggregation the clients read as booksMetadata', async () => {
    const database = await setup([
      {
        name: 'Volume 1',
        document: comicInfo({
          Series: 'Akira',
          Writer: 'Katsuhiro Otomo',
          Tags: 'Cyberpunk',
          Year: '1984',
          Summary: 'Neo-Tokyo.',
        }),
      },
      {
        name: 'Volume 2',
        document: comicInfo({
          Series: 'Akira',
          Writer: 'Katsuhiro Otomo, Someone Else',
          Tags: 'Action',
          Year: '1985',
          Summary: 'A city rebuilt.',
        }),
      },
    ])

    const result = await refreshSeriesMetadata(database.db, 'S1')
    expect(result.aggregationChanged).toBe(true)

    // The aggregation reads the books' metadata, which comes from the documents
    // when each book is refreshed.
    await refreshBookMetadata(database.db, 'B1')
    await refreshBookMetadata(database.db, 'B2')
    await refreshSeriesMetadata(database.db, 'S1')

    const row = await aggregation(database)
    expect(row?.summary).toBe('Neo-Tokyo.')
    expect(row?.summary_number).toBe('1')
    expect(row?.release_date).toBe('1984-01-01')

    const authors = await database.db
      .selectFrom('book_metadata_aggregation_author')
      .select(['name', 'role'])
      .where('series_id', '=', 'S1')
      .execute()
    expect(authors.map((author) => author.name).sort()).toEqual(['Katsuhiro Otomo', 'Someone Else'])

    const tags = await database.db
      .selectFrom('book_metadata_aggregation_tag')
      .select('tag')
      .where('series_id', '=', 'S1')
      .orderBy('tag')
      .execute()
    expect(tags.map((tag) => tag.tag)).toEqual(['action', 'cyberpunk'])
  })

  it('takes the value most of the books agree on, and the earliest on a tie', async () => {
    const database = await setup([
      { name: 'Volume 1', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) },
      { name: 'Volume 2', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) },
      { name: 'Volume 3', document: comicInfo({ Series: 'Akira', Publisher: 'Glénat' }) },
    ])

    await refreshSeriesMetadata(database.db, 'S1')
    expect((await seriesMetadata(database)).publisher).toBe('Kodansha')

    // A tie goes to the earliest book's answer.
    const tied = await setup([
      { name: 'Volume 1', document: comicInfo({ Series: 'Akira', Publisher: 'Glénat' }) },
      { name: 'Volume 2', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) },
    ])
    await refreshSeriesMetadata(tied.db, 'S1')
    expect((await seriesMetadata(tied)).publisher).toBe('Glénat')
  })

  it('takes the highest age rating and the union of the genres', async () => {
    const database = await setup([
      { name: 'Volume 1', document: comicInfo({ Series: 'Akira', AgeRating: 'Teen', Genre: 'Action' }) },
      { name: 'Volume 2', document: comicInfo({ Series: 'Akira', AgeRating: 'Adults Only 18+', Genre: 'Horror' }) },
    ])

    await refreshSeriesMetadata(database.db, 'S1')
    const row = await seriesMetadata(database)
    expect(row.age_rating).toBe(18)
    expect((await genres(database)).map((genre) => genre.genre)).toEqual(['Action', 'Horror'])
  })

  it('appends the volume to the title only when the library asks for it', async () => {
    const books = [
      { name: 'Volume 2', document: comicInfo({ Series: 'Akira', Volume: '2' }) },
    ] satisfies readonly BookSpec[]

    const plain = await setup(books, { import_comic_info_series_append_volume: 0 })
    await refreshSeriesMetadata(plain.db, 'S1')
    expect((await seriesMetadata(plain)).title).toBe('Akira')

    // The reference starts with the volume folded into the title.
    const appending = await setup(books)
    await refreshSeriesMetadata(appending.db, 'S1')
    expect((await seriesMetadata(appending)).title).toBe('Akira (2)')
  })

  it('leaves a locked field alone', async () => {
    const database = await setup([
      { name: 'Volume 1', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) },
    ])
    await database.db.updateTable('series_metadata').set({ title_lock: 1 }).where('series_id', '=', 'S1').execute()

    const result = await refreshSeriesMetadata(database.db, 'S1')
    expect(result.changed).not.toContain('title')

    const row = await seriesMetadata(database)
    expect(row.title).toBe('Akira')
    expect(row.publisher).toBe('Kodansha')
  })

  it('changes nothing the second time', async () => {
    const database = await setup([
      { name: 'Volume 1', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha', Genre: 'Action' }) },
    ])

    await refreshSeriesMetadata(database.db, 'S1')
    const before = await seriesMetadata(database)

    const result = await refreshSeriesMetadata(database.db, 'S1')
    expect(result.status).toBe('unchanged')
    expect(result.changed).toEqual([])
    expect(result.aggregationChanged).toBe(false)
    expect((await seriesMetadata(database)).last_modified_date).toBe(before.last_modified_date)
  })

  it('imports nothing when the library is set not to', async () => {
    const database = await setup(
      [{ name: 'Volume 1', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) }],
      { import_comic_info_series: 0 },
    )

    const result = await refreshSeriesMetadata(database.db, 'S1')
    expect(result.status).toBe('skipped')
    expect((await seriesMetadata(database)).publisher).toBe('')
  })

  it('lets one unreadable book pass while the others are read', async () => {
    const database = await setup([
      { name: 'Volume 1', broken: true },
      { name: 'Volume 2', document: comicInfo({ Series: 'Akira', Publisher: 'Kodansha' }) },
    ])

    await refreshSeriesMetadata(database.db, 'S1')
    expect((await seriesMetadata(database)).publisher).toBe('Kodansha')
  })

  it('aggregates from the books that carry metadata even with no document', async () => {
    const database = await setup([
      { name: 'Volume 1', metadata: { summary: '', releaseDate: '1984-12-06' } },
      { name: 'Volume 2', metadata: { summary: 'A city rebuilt.', releaseDate: '1982-01-01' } },
    ])

    await refreshSeriesMetadata(database.db, 'S1')
    const row = await aggregation(database)
    // The earliest book has no summary, so the next one answers with its own number.
    expect(row?.summary).toBe('A city rebuilt.')
    expect(row?.summary_number).toBe('2')
    expect(row?.release_date).toBe('1982-01-01')
  })
})
