import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { hashBookFile } from '../hashing/books.js'
import { analyzeBook } from '../media/analyze.js'
import { EventBus } from '../events.js'
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

// A folder's date is how a scan knows it changed, and a filesystem stamps it in
// ticks coarser than the time between two steps of a test. So the helper gives
// each folder it writes into a date of its own, later every time.
let folderClock = Date.now()

/** Write files, creating the directories they live in. */
function files(root: string, paths: string[]): void {
  const folders = new Set<string>()
  for (const path of paths) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, path)
    folders.add(dirname(full))
  }
  for (const folder of folders) {
    folderClock += 1000
    utimesSync(folder, new Date(folderClock), new Date(folderClock))
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
      seriesRestored: 0,
      booksRestored: 0,
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

describe('announcing what a scan did', () => {
  /** A bus to collect what the scan published. */
  function collector(): { events: EventBus; seen: { name: string; data: unknown }[] } {
    const events = new EventBus()
    const seen: { name: string; data: unknown }[] = []
    events.subscribe((event) => seen.push({ name: event.name, data: event.data }))
    return { events, seen }
  }

  it('names what it found, with what it belongs to', async () => {
    const { database, root } = await setup()
    const { events, seen } = collector()
    files(root, ['Akira/Volume 1.cbz'])

    await scanLibrary(database.db, 'L1', { events })

    const series = (await seriesRows(database))[0]!
    const book = (await bookRows(database))[0]!
    expect(seen).toEqual([
      { name: 'SeriesAdded', data: { seriesId: series.id, libraryId: 'L1' } },
      { name: 'BookAdded', data: { bookId: book.id, seriesId: series.id, libraryId: 'L1' } },
    ])
  })

  it('names a book that changed, and the series it changed in', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const series = (await seriesRows(database))[0]!
    const book = (await bookRows(database))[0]!
    const { events, seen } = collector()

    // A new page changes the file, which is what a deep scan looks for; an ordinary
    // scan watches the folders, and a file rewritten in place leaves those alone.
    files(root, ['Akira/Volume 1.cbz'])
    utimesSync(join(root, 'Akira/Volume 1.cbz'), new Date(), new Date('2031-01-01T00:00:00Z'))
    await scanLibrary(database.db, 'L1', { deep: true, events })

    expect(seen).toEqual([
      { name: 'BookChanged', data: { bookId: book.id, seriesId: series.id, libraryId: 'L1' } },
      { name: 'SeriesChanged', data: { seriesId: series.id, libraryId: 'L1' } },
    ])
  })

  it('names what a scan soft-deletes', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')

    const series = (await seriesRows(database))[0]!
    const book = (await bookRows(database))[0]!
    const { events, seen } = collector()

    rmSync(join(root, 'Akira'), { recursive: true })
    await scanLibrary(database.db, 'L1', { events })

    expect(seen).toEqual([
      { name: 'SeriesDeleted', data: { seriesId: series.id, libraryId: 'L1' } },
      { name: 'BookDeleted', data: { bookId: book.id, seriesId: series.id, libraryId: 'L1' } },
    ])
  })
})

describe('bringing back what was deleted', () => {
  /** Hash every book, as the job a scan queues would. */
  async function hashAll(database: Database): Promise<void> {
    for (const book of await database.db.selectFrom('books').select('id').execute()) {
      await hashBookFile(database.db, book.id)
    }
  }

  const live = async (database: Database) =>
    (await database.db.selectFrom('books').selectAll().orderBy('name').execute()).filter(
      (book) => book.deleted_date === null,
    )

  it('restores a book whose file comes back, with what was known about it', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz'])
    await scanLibrary(database.db, 'L1')
    await hashAll(database)
    const before = (await bookRows(database)).find((book) => book.name === 'Volume 2')!
    await database.db
      .updateTable('book_metadata')
      .set({ summary: 'Kept by hand' })
      .where('book_id', '=', before.id)
      .execute()

    rmSync(join(root, 'Akira/Volume 2.cbz'))
    await scanLibrary(database.db, 'L1')
    expect((await live(database)).map((book) => book.name)).toEqual(['Volume 1'])

    // Put back by copying, so the file's date is not the one the library recorded.
    files(root, ['Akira/Volume 2.cbz'])
    utimesSync(join(root, 'Akira/Volume 2.cbz'), new Date(), new Date('2031-01-01T00:00:00Z'))
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ booksRestored: 1, booksCreated: 0 })
    const after = (await live(database)).find((book) => book.name === 'Volume 2')!
    expect(after.id).toBe(before.id)
    expect(after.number).toBe(2)
    expect(after.file_last_modified).toBe('2031-01-01T00:00:00.000Z')
    const metadata = await database.db
      .selectFrom('book_metadata')
      .select('summary')
      .where('book_id', '=', before.id)
      .executeTakeFirst()
    expect(metadata?.summary).toBe('Kept by hand')
    expect(await database.db.selectFrom('books').select('id').execute()).toHaveLength(2)
  })

  it('does not restore a book on its name alone when it has no hash', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    const before = (await bookRows(database))[0]!

    rmSync(join(root, 'Akira/Volume 1.cbz'))
    await scanLibrary(database.db, 'L1')
    files(root, ['Akira/Volume 1.cbz'])
    utimesSync(join(root, 'Akira/Volume 1.cbz'), new Date(), new Date('2031-01-01T00:00:00Z'))
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ booksRestored: 0, booksCreated: 1 })
    const books = await live(database)
    expect(books).toHaveLength(1)
    expect(books[0]!.id).not.toBe(before.id)
    // The old book waits in the trash.
    expect(await database.db.selectFrom('books').select('id').execute()).toHaveLength(2)
  })

  it('restores an unhashed book whose file is back exactly as it was', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    const path = join(root, 'Akira/Volume 1.cbz')
    const date = new Date('2030-06-01T00:00:00Z')
    utimesSync(path, date, date)
    await scanLibrary(database.db, 'L1')
    const before = (await bookRows(database))[0]!

    // As when a file returns from a backup with its date intact.
    rmSync(path)
    await scanLibrary(database.db, 'L1')
    files(root, ['Akira/Volume 1.cbz'])
    utimesSync(path, date, date)
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ booksRestored: 1, booksCreated: 0 })
    expect((await live(database)).map((book) => book.id)).toEqual([before.id])
  })

  it('does not take a different file of the same size for a deleted book', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    await hashAll(database)
    const before = (await bookRows(database))[0]!

    rmSync(join(root, 'Akira/Volume 1.cbz'))
    await scanLibrary(database.db, 'L1')
    // The same number of bytes, and other bytes.
    writeFileSync(join(root, 'Akira/Volume 1.cbz'), 'Akira/Volume 9.cbz')
    utimesSync(join(root, 'Akira/Volume 1.cbz'), new Date(), new Date('2031-01-01T00:00:00Z'))
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ booksRestored: 0, booksCreated: 1 })
    expect((await live(database))[0]!.id).not.toBe(before.id)
  })

  it('keeps a series whose folder was renamed', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz', 'Berserk/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    await hashAll(database)
    const series = (await seriesRows(database)).find((row) => row.name === 'Akira')!
    const books = (await bookRows(database, series.id)).map((book) => book.id).sort()

    renameSync(join(root, 'Akira'), join(root, 'Akira (1982)'))
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({
      seriesDeleted: 1,
      seriesRestored: 1,
      seriesCreated: 0,
      booksRestored: 2,
      booksCreated: 0,
    })
    const rows = await seriesRows(database)
    expect(rows.map((row) => [row.name, row.deleted_date])).toEqual([
      ['Akira (1982)', null],
      ['Berserk', null],
    ])
    expect(rows[0]!.id).toBe(series.id)
    expect(rows[0]!.book_count).toBe(2)
    const after = await bookRows(database, series.id)
    expect(after.map((book) => book.id).sort()).toEqual(books)
    expect(after.every((book) => book.deleted_date === null && book.url.includes('Akira%20(1982)'))).toBe(true)
  })

  it('makes a new series of a folder that comes back with another file in it', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    await hashAll(database)
    const series = (await seriesRows(database))[0]!
    const book = (await bookRows(database))[0]!

    renameSync(join(root, 'Akira'), join(root, 'Akira (1982)'))
    files(root, ['Akira (1982)/Volume 2.cbz'])
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ seriesRestored: 0, seriesCreated: 1, booksRestored: 1, booksCreated: 1 })
    const created = (await seriesRows(database)).find((row) => row.deleted_date === null)!
    expect(created.id).not.toBe(series.id)
    // The book it knew moves into the new series rather than being made again.
    const moved = (await live(database)).find((row) => row.name === 'Volume 1')!
    expect(moved.id).toBe(book.id)
    expect(moved.series_id).toBe(created.id)
  })

  it('keeps a book moved from one series to another, whichever is scanned first', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Extra.cbz', 'Berserk/Volume 1.cbz', 'Zetman/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    await hashAll(database)
    const all = await bookRows(database)
    const extra = all.find((book) => book.name === 'Extra')!
    const berserk = all.find((book) => book.url.includes('Berserk'))!
    const series = await seriesRows(database)

    // One moves to a series scanned later than its own, and one to an earlier one.
    renameSync(join(root, 'Akira/Extra.cbz'), join(root, 'Zetman/Side Story.cbz'))
    renameSync(join(root, 'Berserk/Volume 1.cbz'), join(root, 'Akira/Volume 0.cbz'))
    files(root, ['Berserk/Volume 2.cbz'])
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ booksDeleted: 2, booksRestored: 2, booksCreated: 1 })
    const after = await live(database)
    const movedExtra = after.find((book) => book.id === extra.id)!
    expect(movedExtra.name).toBe('Side Story')
    expect(movedExtra.series_id).toBe(series.find((row) => row.name === 'Zetman')!.id)
    expect(after.find((book) => book.id === berserk.id)!.series_id).toBe(series.find((row) => row.name === 'Akira')!.id)
    // A title that was only the file's name follows the file.
    const title = await database.db
      .selectFrom('book_metadata')
      .select('title')
      .where('book_id', '=', extra.id)
      .executeTakeFirst()
    expect(title?.title).toBe('Side Story')
  })
})

describe('a scan that is stopped part-way', () => {
  /**
   * Make the database refuse one book, which stops the scan where it stands -
   * as a restart or a drive going away would, at a place a test can choose.
   */
  async function refuse(database: Database, bookName: string): Promise<() => Promise<void>> {
    await sql`
      create trigger stop_the_scan before insert on books
      when new.name = ${sql.lit(bookName)}
      begin select raise(abort, 'the scan was stopped'); end
    `.execute(database.db)
    return async () => {
      await sql`drop trigger stop_the_scan`.execute(database.db)
    }
  }

  /** Every series the listings would hide or show wrongly, which should be none. */
  async function broken(database: Database): Promise<string[]> {
    const series = await database.db
      .selectFrom('series')
      .leftJoin('series_metadata', 'series_metadata.series_id', 'series.id')
      .select(['series.id', 'series.name', 'series.book_count', 'series_metadata.series_id as metadata'])
      .where('series.deleted_date', 'is', null)
      .execute()

    const problems: string[] = []
    for (const row of series) {
      if (row.metadata === null) problems.push(`${row.name}: no metadata row`)
      const books = await database.db
        .selectFrom('books')
        .leftJoin('book_metadata', 'book_metadata.book_id', 'books.id')
        .select(['books.number', 'book_metadata.book_id as metadata'])
        .where('books.series_id', '=', row.id)
        .where('books.deleted_date', 'is', null)
        .orderBy('books.number')
        .execute()
      if (books.length !== row.book_count) problems.push(`${row.name}: counts ${row.book_count}, has ${books.length}`)
      if (books.some((book) => book.metadata === null)) problems.push(`${row.name}: a book with no metadata row`)
      if (books.some((book, index) => book.number !== index + 1)) problems.push(`${row.name}: books not numbered`)
    }
    return problems
  }

  it('leaves each series whole or absent, and the next scan finishes the library', async () => {
    const { database, root } = await setup()
    files(root, [
      'Akira/Volume 1.cbz',
      'Akira/Volume 2.cbz',
      'Berserk/Volume 1.cbz',
      'Berserk/Volume 2.cbz',
      'Berserk/Volume 3.cbz',
      'Claymore/Volume 1.cbz',
    ])
    const allow = await refuse(database, 'Volume 3')
    const events = new EventBus()
    const seen: string[] = []
    events.subscribe((event) => seen.push(event.name))

    await expect(scanLibrary(database.db, 'L1', { events })).rejects.toThrow('the scan was stopped')

    // The series reached before the stop is complete. The one being written when
    // it came is not there at all - not as a series without books, and not as a
    // series without the row every listing joins to.
    expect((await seriesRows(database)).map((row) => [row.name, row.book_count])).toEqual([['Akira', 2]])
    expect(await database.db.selectFrom('books').select('id').execute()).toHaveLength(2)
    expect(await database.db.selectFrom('series_metadata').select('series_id').execute()).toHaveLength(1)
    expect(await broken(database)).toEqual([])
    // Nobody was told of what was then not kept.
    expect(seen).toEqual(['SeriesAdded', 'BookAdded', 'BookAdded'])

    await allow()
    const summary = await scanLibrary(database.db, 'L1')

    expect(summary).toMatchObject({ seriesCreated: 2, booksCreated: 4, seriesUpdated: 0 })
    expect((await seriesRows(database)).map((row) => [row.name, row.book_count])).toEqual([
      ['Akira', 2],
      ['Berserk', 3],
      ['Claymore', 1],
    ])
    expect(await broken(database)).toEqual([])
  })

  it('does not call a series up to date when its new books were not kept', async () => {
    const { database, root } = await setup()
    files(root, ['Akira/Volume 1.cbz'])
    await scanLibrary(database.db, 'L1')
    const before = (await seriesRows(database))[0]!

    files(root, ['Akira/Volume 2.cbz', 'Akira/Volume 3.cbz'])
    utimesSync(join(root, 'Akira'), new Date(), new Date('2031-01-01T00:00:00Z'))
    const allow = await refuse(database, 'Volume 3')
    await expect(scanLibrary(database.db, 'L1')).rejects.toThrow('the scan was stopped')

    // Volume 2 went in before the stop and came out with it: the series is as it
    // was, down to the folder date the next scan compares against.
    const stopped = (await seriesRows(database))[0]!
    expect(stopped.file_last_modified).toBe(before.file_last_modified)
    expect(stopped.book_count).toBe(1)
    expect(await bookRows(database)).toHaveLength(1)

    await allow()
    const summary = await scanLibrary(database.db, 'L1')
    expect(summary).toMatchObject({ seriesUpdated: 1, booksCreated: 2 })
    expect((await bookRows(database)).map((book) => [book.name, book.number])).toEqual([
      ['Volume 1', 1],
      ['Volume 2', 2],
      ['Volume 3', 3],
    ])
    expect(await broken(database)).toEqual([])
  })
})
