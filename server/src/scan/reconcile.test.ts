import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { analyzeBook } from '../media/analyze.js'
import { SETTING_KEYS, setSetting } from '../settings.js'
import { writeZip } from '../testing/zip.js'
import { scanLibrary } from './reconcile.js'

async function setup(overrides: Record<string, unknown> = {}): Promise<{ database: Database; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-reconcile-'))
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  await database.db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      scan_cbx: 1,
      scan_pdf: 1,
      scan_epub: 1,
      created_date: now,
      last_modified_date: now,
      ...overrides,
    } as never)
    .execute()
  return { database, root }
}

/** Write files, creating the directories they live in. */
function files(root: string, paths: string[]): void {
  for (const path of paths) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, path)
  }
}

/** Write a book that carries a ComicInfo document. */
function bookWithDocument(root: string, relative: string, fields: Record<string, string>): void {
  const full = join(root, relative)
  mkdirSync(dirname(full), { recursive: true })
  const elements = Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join('')
  writeFileSync(
    full,
    writeZip([
      { name: 'page1.jpg', data: Buffer.from('a page') },
      { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo>${elements}</ComicInfo>`, 'utf8') },
    ]),
  )
}

async function seriesRows(database: Database) {
  return database.db.selectFrom('series').selectAll().orderBy('name').execute()
}

async function bookRows(database: Database, seriesId?: string) {
  let builder = database.db.selectFrom('books').selectAll()
  if (seriesId !== undefined) builder = builder.where('series_id', '=', seriesId)
  return builder.orderBy('number').execute()
}

describe('scanning a library', () => {
  it('creates the series and books it finds, numbered from 1', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 10.cbz', 'Akira/Volume 2.cbz', 'Akira/Volume 1.cbz'])

    const summary = await scanLibrary(database.db, 'L1')
    expect(summary).toMatchObject({ seriesCreated: 1, booksCreated: 3 })

    const series = await seriesRows(database)
    expect(series).toHaveLength(1)
    expect(series[0]?.name).toBe('Akira')
    expect(series[0]?.url.startsWith('file:')).toBe(true)

    const books = await bookRows(database)
    // Numbered in the order a reader expects, not lexicographically.
    expect(books.map((book) => [book.name, book.number])).toEqual([
      ['Volume 1', 1],
      ['Volume 2', 2],
      ['Volume 10', 3],
    ])
    expect(books[0]?.url.startsWith('file:')).toBe(true)

    // Every series and book gets the metadata row the rest of the API expects.
    const seriesMeta = await database.db.selectFrom('series_metadata').selectAll().execute()
    expect(seriesMeta).toHaveLength(1)
    expect(seriesMeta[0]?.title).toBe('Akira')
    const bookMeta = await database.db.selectFrom('book_metadata').selectAll().execute()
    expect(bookMeta).toHaveLength(3)
    expect(bookMeta.map((row) => row.number).sort()).toEqual(['1', '2', '3'])
  })

  it('changes nothing when nothing changed', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const second = await scanLibrary(database.db, 'L1')
    expect(second).toEqual({
      seriesCreated: 0,
      seriesUpdated: 0,
      seriesDeleted: 0,
      booksCreated: 0,
      booksUpdated: 0,
      booksDeleted: 0,
      collectionsDeleted: 0,
      readListsDeleted: 0,
    })
  })

  it('adds a new book and renumbers', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz'])
    await scanLibrary(database.db, 'L1')

    files(root, ['Akira/Volume 10.cbz'])
    const summary = await scanLibrary(database.db, 'L1')
    expect(summary.booksCreated).toBe(1)

    expect((await bookRows(database)).map((book) => [book.name, book.number])).toEqual([
      ['Volume 1', 1],
      ['Volume 2', 2],
      ['Volume 10', 3],
    ])
  })

  it('soft-deletes a book that is gone, and renumbers the rest', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz', 'Akira/Volume 3.cbz'])
    await scanLibrary(database.db, 'L1')

    rmSync(join(root, 'Akira/Volume 2.cbz'))
    const summary = await scanLibrary(database.db, 'L1')
    expect(summary.booksDeleted).toBe(1)

    const all = await database.db.selectFrom('books').selectAll().execute()
    const deleted = all.filter((book) => book.deleted_date !== null)
    expect(deleted.map((book) => book.name)).toEqual(['Volume 2'])

    // The soft-deleted book no longer takes a number, so the rest close up.
    expect(
      (await bookRows(database)).filter((book) => book.deleted_date === null).map((book) => [book.name, book.number]),
    ).toEqual([
      ['Volume 1', 1],
      ['Volume 3', 2],
    ])
  })

  it('soft-deletes a series whose folder is gone, and everything under it', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Berserk/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    rmSync(join(root, 'Akira'), { recursive: true })
    const summary = await scanLibrary(database.db, 'L1')
    expect(summary.seriesDeleted).toBe(1)
    expect(summary.booksDeleted).toBe(1)

    const series = await seriesRows(database)
    expect(series.find((row) => row.name === 'Akira')?.deleted_date).not.toBeNull()
    expect(series.find((row) => row.name === 'Berserk')?.deleted_date).toBeNull()
  })

  it('soft-deletes everything when the folder is empty', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    rmSync(join(root, 'Akira'), { recursive: true })
    await scanLibrary(database.db, 'L1')

    expect((await seriesRows(database)).every((row) => row.deleted_date !== null)).toBe(true)
  })

  it('empties the trash at the end when the library asks for it', async () => {
    const { database, root } = await setup({ empty_trash_after_scan: 1 })
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz'])
    await scanLibrary(database.db, 'L1')

    rmSync(join(root, 'Akira/Volume 2.cbz'))
    await scanLibrary(database.db, 'L1')

    // The trash was emptied, so the row is really gone rather than soft-deleted.
    expect((await database.db.selectFrom('books').selectAll().execute()).map((book) => book.name)).toEqual(['Volume 1'])
  })

  it('removes a collection and a read list the emptied trash left holding nothing', async () => {
    const { database, root } = await setup({ empty_trash_after_scan: 1 })
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const series = (await seriesRows(database))[0]!
    const book = (await bookRows(database))[0]!
    const now = new Date().toISOString()
    await database.db
      .insertInto('collections')
      .values({ id: 'C1', name: 'Favourites', created_date: now, last_modified_date: now })
      .execute()
    await database.db
      .insertInto('collection_series')
      .values({ collection_id: 'C1', series_id: series.id, number: 0 })
      .execute()
    await database.db
      .insertInto('readlists')
      .values({ id: 'R1', name: 'To read', created_date: now, last_modified_date: now })
      .execute()
    await database.db.insertInto('readlist_book').values({ readlist_id: 'R1', book_id: book.id, number: 0 }).execute()

    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')
    await setSetting(database.db, SETTING_KEYS.deleteEmptyReadLists, 'true')

    rmSync(join(root, 'Akira'), { recursive: true })
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary.collectionsDeleted).toBe(1)
    expect(summary.readListsDeleted).toBe(1)
    expect(await database.db.selectFrom('collections').selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom('readlists').selectAll().execute()).toEqual([])
  })

  it('leaves them alone when the settings are off, even though the trash was emptied', async () => {
    const { database, root } = await setup({ empty_trash_after_scan: 1 })
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const series = (await seriesRows(database))[0]!
    const now = new Date().toISOString()
    await database.db
      .insertInto('collections')
      .values({ id: 'C1', name: 'Favourites', created_date: now, last_modified_date: now })
      .execute()
    await database.db
      .insertInto('collection_series')
      .values({ collection_id: 'C1', series_id: series.id, number: 0 })
      .execute()

    rmSync(join(root, 'Akira'), { recursive: true })
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary.collectionsDeleted).toBe(0)
    // The series went for good, so the membership did too: the collection is empty
    // but still there, which is what leaving the setting off means.
    expect(await database.db.selectFrom('collection_series').selectAll().execute()).toEqual([])
    expect((await database.db.selectFrom('collections').selectAll().execute()).map((row) => row.id)).toEqual(['C1'])
  })

  it('marks a changed book outdated when the scan is deep', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const book = (await bookRows(database))[0]!
    const now = new Date().toISOString()
    await database.db
      .insertInto('media')
      .values({
        book_id: book.id,
        media_type: 'application/zip',
        status: 'READY',
        comment: null,
        page_count: 1,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    // The walk takes the later of the creation and modified times, so the change
    // has to move the modified time past the creation time.
    utimesSync(join(root, 'Akira/Volume 1.cbz'), new Date(), new Date('2030-02-03T04:05:06Z'))
    const summary = await scanLibrary(database.db, 'L1', { deep: true })
    expect(summary.booksUpdated).toBe(1)

    const media = await database.db
      .selectFrom('media')
      .selectAll()
      .where('book_id', '=', book.id)
      .executeTakeFirstOrThrow()
    expect(media.status).toBe('OUTDATED')
  })

  it('marks the library unavailable when the root is excluded, and clears it again', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])

    await scanLibrary(database.db, 'L1')
    await database.db
      .updateTable('libraries')
      .set({ scan_directory_exclusions: JSON.stringify([root]) })
      .where('id', '=', 'L1')
      .execute()

    await expect(scanLibrary(database.db, 'L1')).rejects.toThrow()
    let library = await database.db.selectFrom('libraries').selectAll().where('id', '=', 'L1').executeTakeFirstOrThrow()
    expect(library.unavailable_date).not.toBeNull()

    await database.db.updateTable('libraries').set({ scan_directory_exclusions: '[]' }).where('id', '=', 'L1').execute()
    await scanLibrary(database.db, 'L1')
    library = await database.db.selectFrom('libraries').selectAll().where('id', '=', 'L1').executeTakeFirstOrThrow()
    expect(library.unavailable_date).toBeNull()
  })

  it('marks a oneshots folder as a series per file', async () => {
    const { database, root } = await setup({ oneshots_directory: 'oneshots' })
    files(root, ['oneshots/One Shot.cbz', 'oneshots/Another.cbz'])

    await scanLibrary(database.db, 'L1')
    const series = await seriesRows(database)
    expect(series.map((row) => [row.name, row.oneshot])).toEqual([
      ['Another', 1],
      ['One Shot', 1],
    ])
  })

  it('reads a series\u2019 metadata out of the books it found', async () => {
    const { database, root } = await setup()
    bookWithDocument(root, 'Akira/Volume 1.cbz', {
      Series: 'Akira',
      Publisher: 'Kodansha',
      Genre: 'Science Fiction',
      Writer: 'Katsuhiro Otomo',
      Tags: 'Cyberpunk',
      Year: '1984',
      Summary: 'Neo-Tokyo.',
    })
    bookWithDocument(root, 'Akira/Volume 2.cbz', { Series: 'Akira', Publisher: 'Kodansha', Year: '1985' })

    await scanLibrary(database.db, 'L1')

    const series = (await seriesRows(database))[0]!
    const metadata = await database.db
      .selectFrom('series_metadata')
      .selectAll()
      .where('series_id', '=', series.id)
      .executeTakeFirstOrThrow()
    expect(metadata.publisher).toBe('Kodansha')

    // The books' own metadata arrives when they are analysed, and the series'
    // view of them - what the clients read as booksMetadata - is recomputed then.
    for (const book of await bookRows(database)) {
      await analyzeBook(database.db, book.id, join(root, `Akira/${book.name}.cbz`), {})
    }

    const aggregation = await database.db.selectFrom('book_metadata_aggregation').selectAll().execute()
    expect(aggregation).toHaveLength(1)
    expect(aggregation[0]?.release_date).toBe('1984-01-01')
    expect(aggregation[0]?.summary).toBe('Neo-Tokyo.')

    const authors = await database.db.selectFrom('book_metadata_aggregation_author').select('name').execute()
    expect(authors.map((row) => row.name)).toEqual(['Katsuhiro Otomo'])
  })
})
