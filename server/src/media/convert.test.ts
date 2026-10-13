import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { beforeEach, describe, expect, it } from 'vitest'

import { updatedTime } from '../content/files.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { eventTypeName } from '../routes/maintenance.js'
import { writeRar } from '../testing/rar.js'
import { writeZip } from '../testing/zip.js'
import { analyzeBook } from './analyze.js'
import { booksToConvert, convertBookToCbz, forgetFailedConversions, isRarMediaType } from './convert.js'
import { openBook } from './index.js'

const page = (shade: number): Promise<Buffer> =>
  sharp({ create: { width: 20, height: 30, channels: 3, background: { r: shade, g: 60, b: 90 } } })
    .jpeg()
    .toBuffer()

interface Fixture {
  database: Database
  root: string
  /** Where the CBR is. */
  cbr: string
  pages: Buffer[]
}

/** A library that asks for conversion, holding one analysed CBR of three pages and a ComicInfo. */
async function setup(options: { convert?: boolean } = {}): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-convert-')))
  const pages = [await page(10), await page(120), await page(240)]
  const cbr = join(root, 'Volume 1.cbr')
  writeFileSync(
    cbr,
    writeRar([
      { name: 'p1.jpg', data: pages[0]! },
      { name: 'p2.jpg', data: pages[1]! },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>One</Title></ComicInfo>') },
      { name: 'p3.jpg', data: pages[2]! },
    ]),
  )

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  await database.db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      convert_to_cbz: options.convert === false ? 0 : 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Akira',
      url: pathToFileURL(root).href,
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: pathToFileURL(cbr).href,
      file_last_modified: updatedTime(statSync(cbr)).toISOString(),
      file_size: statSync(cbr).size,
      file_hash: 'hash-of-the-cbr',
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  expect((await analyzeBook(database.db, 'B1', cbr)).status).toBe('READY')
  // What hashing found for one of its pages, which a conversion is to keep.
  await database.db
    .updateTable('media_page')
    .set({ file_hash: 'hash-of-page-2' })
    .where('book_id', '=', 'B1')
    .where('file_name', '=', 'p2.jpg')
    .execute()

  return { database, root, cbr, pages }
}

const book = (database: Database) =>
  database.db.selectFrom('books').selectAll().where('id', '=', 'B1').executeTakeFirstOrThrow()
const media = (database: Database) =>
  database.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()

beforeEach(() => forgetFailedConversions())

describe('converting a CBR to a CBZ', () => {
  it('writes the CBZ, checks it, removes the CBR and keeps the book', async () => {
    const { database, root, cbr, pages } = await setup()
    const cbz = join(root, 'Volume 1.cbz')

    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'CONVERTED', from: cbr, to: cbz })

    expect(readdirSync(root)).toEqual(['Volume 1.cbz'])
    const converted = await openBook(cbz)
    try {
      expect(converted.pages.map((entry) => entry.fileName)).toEqual(['p1.jpg', 'p2.jpg', 'p3.jpg'])
      expect((await converted.readPage(2)).equals(pages[1]!)).toBe(true)
      expect((await converted.readResource('ComicInfo.xml')).toString()).toContain('<Title>One</Title>')
    } finally {
      converted.close()
    }

    // The same book, pointed at the new file.
    const row = await book(database)
    expect(row).toMatchObject({
      id: 'B1',
      name: 'Volume 1',
      url: pathToFileURL(cbz).href,
      file_size: statSync(cbz).size,
    })
    expect(row.file_last_modified).toBe(updatedTime(statSync(cbz)).toISOString())
    // A hash of the file that is gone is no hash of this one.
    expect(row.file_hash).toBeNull()
    expect(await media(database)).toMatchObject({ status: 'READY', media_type: 'application/zip', page_count: 3 })

    const hashes = await database.db
      .selectFrom('media_page')
      .select(['file_name', 'file_hash'])
      .where('book_id', '=', 'B1')
      .orderBy('number')
      .execute()
    expect(hashes.find((entry) => entry.file_name === 'p2.jpg')?.file_hash).toBe('hash-of-page-2')

    const events = await database.db.selectFrom('historical_events').selectAll().orderBy('type').execute()
    expect(events.map((event) => [eventTypeName(event.type), event.book_id, JSON.parse(event.properties)])).toEqual([
      ['BookConverted', 'B1', { name: cbz, 'former file': cbr }],
      ['BookFileDeleted', 'B1', { name: cbr, reason: 'File was deleted after conversion to CBZ' }],
    ])

    // Asked again, there is no RAR left to convert.
    expect((await convertBookToCbz(database.db, 'B1')).status).toBe('UNSUPPORTED')
    expect(await booksToConvert(database.db, 'L1')).toEqual([])
  })

  it('does nothing when the library does not ask for it', async () => {
    const { database, root } = await setup({ convert: false })

    expect(await booksToConvert(database.db, 'L1')).toEqual([])
    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'DISABLED' })
    expect(readdirSync(root)).toEqual(['Volume 1.cbr'])
  })

  it('does not write over a CBZ that is already there', async () => {
    const { database, root } = await setup()
    writeFileSync(join(root, 'Volume 1.cbz'), 'somebody else put this here')

    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'EXISTS' })
    expect(readFileSync(join(root, 'Volume 1.cbz')).toString()).toBe('somebody else put this here')
    expect(existsSync(join(root, 'Volume 1.cbr'))).toBe(true)
  })

  it('leaves a file alone that changed since it was scanned', async () => {
    const { database, root, cbr } = await setup()
    utimesSync(cbr, new Date(), new Date('2031-01-01T00:00:00Z'))

    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'CHANGED' })
    expect(readdirSync(root)).toEqual(['Volume 1.cbr'])
  })

  it('leaves the CBR exactly as it was when the CBZ cannot be made whole', async () => {
    const { database, root, cbr } = await setup()
    const before = readFileSync(cbr)
    // The book is recorded as holding a file its archive does not have, so the
    // new archive cannot be written with everything in it.
    await database.db.insertInto('media_file').values({ book_id: 'B1', file_name: 'lost.txt' }).execute()

    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'FAILED' })

    // No CBZ, nothing half-written, and the book is still the CBR.
    expect(readdirSync(root)).toEqual(['Volume 1.cbr'])
    expect(readFileSync(cbr).equals(before)).toBe(true)
    expect((await book(database)).url).toBe(pathToFileURL(cbr).href)
    expect((await book(database)).file_hash).toBe('hash-of-the-cbr')
    expect(isRarMediaType((await media(database)).media_type)).toBe(true)
    expect(await database.db.selectFrom('historical_events').selectAll().execute()).toEqual([])

    // And it is not tried again at every scan.
    expect(await convertBookToCbz(database.db, 'B1')).toEqual({ status: 'FAILED_BEFORE' })
    expect(await booksToConvert(database.db, 'L1')).toEqual([])
  })

  it('only takes analysed RAR books', async () => {
    const { database, root } = await setup()
    expect(await booksToConvert(database.db, 'L1')).toEqual(['B1'])

    // A CBZ is not a candidate, whatever the library asks.
    const cbz = join(root, 'Volume 2.cbz')
    writeFileSync(cbz, writeZip([{ name: '1.jpg', data: await page(1) }]))
    const now = new Date().toISOString()
    await database.db
      .insertInto('books')
      .values({
        id: 'B2',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 2',
        url: pathToFileURL(cbz).href,
        file_last_modified: updatedTime(statSync(cbz)).toISOString(),
        file_size: statSync(cbz).size,
        number: 2,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await analyzeBook(database.db, 'B2', cbz)

    expect(await booksToConvert(database.db, 'L1')).toEqual(['B1'])
    expect(await convertBookToCbz(database.db, 'B2')).toEqual({ status: 'UNSUPPORTED' })
    expect(await convertBookToCbz(database.db, 'B9')).toEqual({ status: 'GONE' })
  })
})

describe('names', () => {
  it('knows a RAR as this server or the reference records it', () => {
    expect(isRarMediaType('application/x-rar-compressed')).toBe(true)
    expect(isRarMediaType('application/x-rar-compressed; version=5')).toBe(true)
    expect(isRarMediaType('application/zip')).toBe(false)
    expect(isRarMediaType(null)).toBe(false)
  })

  it('gives a history event the name the reference gives it', () => {
    expect(eventTypeName('BOOK_CONVERTED')).toBe('BookConverted')
    expect(eventTypeName('DUPLICATE_PAGE_DELETED')).toBe('DuplicatePageDeleted')
    // Already right, as a row from Komga is.
    expect(eventTypeName('BookFileDeleted')).toBe('BookFileDeleted')
    expect(eventTypeName('TaskFailed')).toBe('TaskFailed')
  })
})
