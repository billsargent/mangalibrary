import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { writeZip } from '../testing/zip.js'
import { barcodeInImage, isbnBarcodePatch, pagesToSearch } from './barcode.js'
import { refreshBookMetadata } from './refresh.js'

/** An ISBN that is a valid EAN-13 too, which is what an ISBN barcode carries. */
const ISBN = '9780306406157'
/** A second valid EAN-13, so a test can tell two values apart. */
const OTHER_EAN = '4006381333931'

/** The three ways a digit is drawn in EAN-13: odd parity, even parity, and right. */
const LEFT_ODD = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
]
const LEFT_EVEN = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
]
const RIGHT = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
]
/** Which of the two left hand sets each position uses, for the leading digit. */
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

/** The modules of an EAN-13 barcode, as a string of bars and spaces. */
function ean13Modules(text: string): string {
  const digits = [...text].map(Number)
  const parity = PARITY[digits[0] ?? 0] ?? ''

  let modules = '101'
  for (let position = 1; position <= 6; position += 1) {
    const set = parity[position - 1] === 'L' ? LEFT_ODD : LEFT_EVEN
    modules += set[digits[position] ?? 0]
  }
  modules += '01010'
  for (let position = 7; position <= 12; position += 1) modules += RIGHT[digits[position] ?? 0]
  return `${modules}101`
}

/**
 * A real EAN-13 barcode, drawn as a PNG.
 *
 * The bars are laid out from the standard's digit patterns and the picture is made
 * with sharp, because the decoding library carries readers but no writer for a
 * one-dimensional code. What a test gets is a genuine barcode image, which is what
 * matters: the pixels are decoded by a library that knows nothing about how they
 * were drawn.
 */
async function ean13Image(text: string, moduleWidth = 3): Promise<Buffer> {
  // Nine modules of quiet zone at each end, which a scanner needs to find the code.
  const modules = `${'0'.repeat(9)}${ean13Modules(text)}${'0'.repeat(9)}`
  const width = modules.length * moduleWidth
  const height = 120
  const pixels = Buffer.alloc(width * height, 255)

  for (const [index, module] of [...modules].entries()) {
    if (module !== '1') continue
    for (let y = 0; y < height; y += 1) {
      for (let x = index * moduleWidth; x < (index + 1) * moduleWidth; x += 1) pixels[y * width + x] = 0
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
}

/** A plain page image, with nothing on it to read. */
async function blankPage(): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 250, g: 250, b: 250 } } })
    .png()
    .toBuffer()
}

/**
 * A library holding one book at a path, in its own series.
 *
 * The book is written to disk as the pages given, so a test can put a barcode on a
 * page where the reader would look - or where it would not.
 */
async function setup(
  options: {
    pages?: Buffer[]
    comicInfo?: string
    importComicInfo?: number
    importBarcode?: number
    name?: string
  } = {},
): Promise<{ database: Database; path: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-barcode-root-'))
  const name = options.name ?? 'Volume 1.cbz'
  const path = join(root, name)
  const entries = (options.pages ?? [await blankPage()]).map((data, index) => ({
    name: `${String(index + 1).padStart(3, '0')}.png`,
    data,
  }))
  if (options.comicInfo !== undefined) {
    entries.push({ name: 'ComicInfo.xml', data: Buffer.from(options.comicInfo, 'utf8') })
  }
  writeFileSync(path, writeZip(entries))

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      import_comic_info_book: options.importComicInfo ?? 1,
      import_barcode_isbn: options.importBarcode ?? 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Akira',
      url: '.',
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
      name: 'Volume 1',
      url: name,
      file_last_modified: now,
      file_size: 0,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('book_metadata')
    .values({ book_id: 'B1', title: 'Volume 1', created_date: now, last_modified_date: now })
    .execute()

  return { database, path }
}

/** The ISBN stored for the fixture's book. */
async function storedIsbn(database: Database): Promise<string | null> {
  const row = await database.db
    .selectFrom('book_metadata')
    .select('isbn')
    .where('book_id', '=', 'B1')
    .executeTakeFirstOrThrow()
  return row.isbn
}

describe('reading a barcode', () => {
  it('reads an EAN-13 out of an image', async () => {
    expect(await barcodeInImage(await ean13Image(ISBN))).toBe(ISBN)
  })

  it('finds nothing in an image without one', async () => {
    expect(await barcodeInImage(await blankPage())).toBeNull()
    expect(await barcodeInImage(Buffer.from('not an image at all'))).toBeNull()
  })

  it('looks at both ends of a book, from the back', () => {
    // The back cover first, then the front, and never the same page twice.
    expect(pagesToSearch(10)).toEqual([10, 9, 8, 1, 2, 3])
    expect(pagesToSearch(4)).toEqual([4, 3, 2, 1])
    expect(pagesToSearch(2)).toEqual([2, 1])
    expect(pagesToSearch(0)).toEqual([])
  })

  it('reads an ISBN from a page of a book', async () => {
    const { database, path } = await setup({ pages: [await blankPage(), await ean13Image(ISBN)] })

    expect(await isbnBarcodePatch(path)).toEqual({ isbn: ISBN })
    await database.close()
  })

  it('does not find a barcode in the middle of a book', async () => {
    // The barcode is on page 10 of 20, where neither end reaches it.
    const pages = Array.from({ length: 20 }, () => undefined as Buffer | undefined)
    pages[9] = await ean13Image(ISBN)
    const filled = await Promise.all(pages.map(async (page) => page ?? (await blankPage())))
    const { database, path } = await setup({ pages: filled })

    expect(await isbnBarcodePatch(path)).toBeNull()
    await database.close()
  })

  it('says nothing about a book it cannot open', async () => {
    const { database, path } = await setup({ pages: [Buffer.from('not an image')] })

    expect(await isbnBarcodePatch(path)).toBeNull()
    // A path that is not there is not an error either.
    expect(await isbnBarcodePatch(join(path, 'nowhere.cbz'))).toBeNull()
    await database.close()
  })
})

describe('an ISBN read from a barcode', () => {
  it('is written when the library imports it', async () => {
    const { database } = await setup({ pages: [await blankPage(), await ean13Image(ISBN)] })

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('changed')
    expect(result.changed).toContain('isbn')
    expect(await storedIsbn(database)).toBe(ISBN)

    await database.close()
  })

  it('is not read when the library is set not to import it', async () => {
    const { database } = await setup({ pages: [await ean13Image(ISBN)], importBarcode: 0 })

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('no metadata document')
    expect(await storedIsbn(database)).not.toBe(ISBN)

    await database.close()
  })

  it('is not read for an ISBN a document already states', async () => {
    // The document is the more specific statement of the two, so it wins even
    // though the barcode is read from the book itself.
    const { database } = await setup({
      pages: [await ean13Image(OTHER_EAN)],
      comicInfo: '<ComicInfo><Series>Akira</Series><GTIN>9780306406157</GTIN></ComicInfo>',
    })

    await refreshBookMetadata(database.db, 'B1')
    expect(await storedIsbn(database)).toBe(ISBN)

    await database.close()
  })

  it('is used when the library does not import documents at all', async () => {
    const { database } = await setup({
      pages: [await ean13Image(OTHER_EAN)],
      comicInfo: '<ComicInfo><Series>Akira</Series><GTIN>9780306406157</GTIN></ComicInfo>',
      importComicInfo: 0,
    })

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('changed')
    expect(await storedIsbn(database)).toBe(OTHER_EAN)

    await database.close()
  })

  it('leaves the field alone when the user has locked it', async () => {
    const { database } = await setup({ pages: [await ean13Image(ISBN)] })
    await database.db
      .updateTable('book_metadata')
      .set({ isbn: 'old', isbn_lock: 1 })
      .where('book_id', '=', 'B1')
      .execute()

    await refreshBookMetadata(database.db, 'B1')
    expect(await storedIsbn(database)).toBe('old')

    await database.close()
  })
})
