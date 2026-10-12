import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import yauzl from 'yauzl'

import { updatedTime } from '../content/files.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { minimalPdf } from '../spikes/minimalPdf.js'
import { writeZip } from '../testing/zip.js'
import { analyzeBook } from './analyze.js'
import { pagesToRemoveAutomatically, removeHashedPages, type PageToRemove } from './removePages.js'

/** Page images, made once and reused: encoding one is far slower than the tests. */
const madePages = new Map<number, Buffer>()

async function page(seed: number): Promise<Buffer> {
  const made = madePages.get(seed)
  if (made !== undefined) return made

  const bytes = await sharp({
    create: { width: 40, height: 60, channels: 3, background: { r: seed, g: seed, b: seed } },
  })
    .png()
    .toBuffer()
  madePages.set(seed, bytes)
  return bytes
}

/** Read a ZIP back with an independent reader, weakest thing that can go wrong first. */
function readZip(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) return reject(error ?? new Error('not a zip'))
      const entries: { name: string; data: Buffer }[] = []
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('no entry stream'))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) })
            zipfile.readEntry()
          })
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

/**
 * A library holding one book, analysed, with every page hashed.
 *
 * The book's modified time is written the way a scan writes it, because the first
 * thing a removal does is check that the file has not changed since then.
 */
async function setup(
  options: { pageCount?: number; pdf?: boolean; name?: string } = {},
): Promise<{ database: Database; root: string; bookId: string; path: string; pages: PageToRemove[] }> {
  const pageCount = options.pageCount ?? 4
  const name = options.name ?? 'v1.cbz'
  const root = mkdtempSync(join(tmpdir(), 'ml-removal-'))

  const entries: { name: string; data: Buffer }[] = []
  for (let number = 1; number <= pageCount; number += 1) {
    entries.push({ name: `${number}.png`, data: await page(number * 10) })
  }
  entries.push({ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Removal</Series></ComicInfo>', 'utf8') })

  const path = join(root, name)
  writeFileSync(path, options.pdf === true ? minimalPdf() : writeZip(entries))

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Series',
      url: 'series',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume',
      url: name,
      file_last_modified: updatedTime(statSync(path)).toISOString(),
      file_size: statSync(path).size,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  await analyzeBook(db, 'B1', path)

  const rows = await db.selectFrom('media_page').selectAll().where('book_id', '=', 'B1').orderBy('number').execute()
  for (const row of rows) {
    await db
      .updateTable('media_page')
      .set({ file_hash: `hash-${row.number}` })
      .where('book_id', '=', 'B1')
      .where('number', '=', row.number)
      .execute()
  }

  return {
    database,
    root,
    bookId: 'B1',
    path,
    pages: rows.map((row) => ({
      fileName: row.file_name,
      mediaType: row.media_type,
      fileHash: `hash-${row.number}`,
      fileSize: row.file_size,
      pageNumber: row.number,
    })),
  }
}

/** A book's page rows, as they now are. */
async function pagesOf(database: Database, bookId: string) {
  return database.db
    .selectFrom('media_page')
    .select(['number', 'file_name', 'file_hash'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()
}

describe('removing duplicate pages', () => {
  it('writes the book again without the page, and keeps the hashes of the rest', async () => {
    const { database, bookId, path, pages } = await setup()

    const result = await removeHashedPages(database.db, bookId, [pages[1]!])
    expect(result).toEqual({ status: 'REMOVED', pages: 1, removedFirstPage: false })

    // The file holds the three pages that stayed, and the document it carried.
    const entries = await readZip(readFileSync(path))
    expect(entries.map((entry) => entry.name)).toEqual(['1.png', '3.png', '4.png', 'ComicInfo.xml'])

    // And the book describes what it now is, with the hashes of the pages that
    // stayed, renumbered from one.
    expect(await pagesOf(database, bookId)).toEqual([
      { number: 1, file_name: '1.png', file_hash: 'hash-1' },
      { number: 2, file_name: '3.png', file_hash: 'hash-3' },
      { number: 3, file_name: '4.png', file_hash: 'hash-4' },
    ])

    const book = await database.db.selectFrom('books').selectAll().where('id', '=', bookId).executeTakeFirstOrThrow()
    expect(book.file_size).toBe(statSync(path).size)
    expect(book.file_last_modified).toBe(updatedTime(statSync(path)).toISOString())

    await database.close()
  })

  it('says whether the page a poster is made from was one of them', async () => {
    const { database, bookId, pages } = await setup()

    expect((await removeHashedPages(database.db, bookId, [pages[0]!])).removedFirstPage).toBe(true)

    await database.close()
  })

  it('counts a removal against the hash somebody judged', async () => {
    const { database, bookId, pages } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('page_hash')
      .values({ hash: 'hash-2', size: null, action: 'DELETE_MANUAL', created_date: now, last_modified_date: now })
      .execute()

    await removeHashedPages(database.db, bookId, [pages[1]!])

    const row = await database.db
      .selectFrom('page_hash')
      .selectAll()
      .where('hash', '=', 'hash-2')
      .executeTakeFirstOrThrow()
    expect(row.delete_count).toBe(1)

    // And the removal is in the history, where an operator can see what happened to
    // a file they own.
    const events = await database.db.selectFrom('historical_events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('DUPLICATE_PAGE_DELETED')
    expect(events[0]!.book_id).toBe('B1')
    expect(JSON.parse(events[0]!.properties)).toMatchObject({ 'page file name': '2.png', 'page number': '2' })

    await database.close()
  })

  it('removes every page named in one go', async () => {
    const { database, bookId, path, pages } = await setup()

    const result = await removeHashedPages(database.db, bookId, [pages[0]!, pages[2]!])
    expect(result.pages).toBe(2)
    expect((await readZip(readFileSync(path))).map((entry) => entry.name)).toEqual(['2.png', '4.png', 'ComicInfo.xml'])

    await database.close()
  })

  it('leaves the book alone when its file changed since it was scanned', async () => {
    const { database, bookId, path, pages } = await setup()
    const before = readFileSync(path)

    // A file that was replaced since the scan is not the book this was queued for.
    await database.db
      .updateTable('books')
      .set({ file_last_modified: '2020-01-01T00:00:00.000Z' })
      .where('id', '=', bookId)
      .execute()

    expect((await removeHashedPages(database.db, bookId, [pages[0]!])).status).toBe('CHANGED')
    expect(readFileSync(path)).toEqual(before)
    expect(await pagesOf(database, bookId)).toHaveLength(4)

    await database.close()
  })

  it('touches nothing when the pages named are not the pages it has', async () => {
    const { database, bookId, path, pages } = await setup()
    const before = readFileSync(path)

    const wrong = { ...pages[0]!, fileName: 'not-a-page.png' }
    expect((await removeHashedPages(database.db, bookId, [wrong])).status).toBe('MISMATCH')

    // A page number that is there, and a name that is not, is the same answer.
    const alsoWrong = { ...pages[0]!, fileHash: 'another-hash' }
    expect((await removeHashedPages(database.db, bookId, [alsoWrong])).status).toBe('MISMATCH')

    expect(readFileSync(path)).toEqual(before)

    await database.close()
  })

  it('refuses a book that is not a comic archive', async () => {
    const { database, pages } = await setup({ name: 'v1.pdf', pdf: true })
    expect(pages.length).toBeGreaterThan(0)

    expect((await removeHashedPages(database.db, 'B1', [pages[0]!])).status).toBe('UNSUPPORTED')
    expect((await removeHashedPages(database.db, 'gone', [pages[0]!])).status).toBe('GONE')
    expect((await removeHashedPages(database.db, 'B1', [])).status).toBe('MISMATCH')

    await database.close()
  })
})

describe('the pages a library removes by itself', () => {
  it('are the ones whose hash is marked for automatic removal', async () => {
    const { database, pages } = await setup()
    const now = new Date().toISOString()

    await database.db
      .insertInto('page_hash')
      .values([
        { hash: 'hash-1', size: null, action: 'DELETE_AUTO', created_date: now, last_modified_date: now },
        { hash: 'hash-2', size: null, action: 'IGNORE', created_date: now, last_modified_date: now },
        { hash: 'hash-3', size: null, action: 'DELETE_MANUAL', created_date: now, last_modified_date: now },
      ])
      .execute()

    expect(await pagesToRemoveAutomatically(database.db, 'L1')).toEqual([
      { bookId: 'B1', pages: [{ ...pages[0]!, fileHash: 'hash-1' }] },
    ])

    // A book in the trash is not rewritten.
    await database.db.updateTable('books').set({ deleted_date: now }).where('id', '=', 'B1').execute()
    expect(await pagesToRemoveAutomatically(database.db, 'L1')).toEqual([])

    await database.close()
  })
})
