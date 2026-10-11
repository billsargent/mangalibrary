import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { minimalPdf } from '../spikes/minimalPdf.js'
import { analyzeBook } from './analyze.js'
import { naturalCompare } from './kinds.js'

// ------------------------------------------------------------------- fixtures

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * Build a zip with stored (uncompressed) entries.
 *
 * A zip is what a CBZ and an EPUB both are, so one small writer gives fixtures for
 * both without depending on an archive tool being installed.
 */
function writeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, file.data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(file.data.length, 20)
    header.writeUInt32LE(file.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + file.data.length
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, ...central, end])
}

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

function writeBook(name: string, data: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'ml-media-'))
  const path = join(root, name)
  writeFileSync(path, data)
  return path
}

async function database(): Promise<Database> {
  const db = createDatabase(':memory:')
  await migrate(db.db, migrations)
  const now = new Date().toISOString()
  await db.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now })
    .execute()
  await db.db
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
  await db.db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'v1.cbz',
      file_last_modified: now,
      file_size: 0,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  return db
}

// ---------------------------------------------------------------------- tests

describe('page ordering', () => {
  it('sorts numbered files the way a reader expects', () => {
    expect(['10.jpg', '9.jpg', '1.jpg'].sort(naturalCompare)).toEqual(['1.jpg', '9.jpg', '10.jpg'])
    // Not the lexicographic order, which would put page-10 before page-2.
    expect(['page-2.png', 'page-10.png', 'page-1.png'].sort(naturalCompare)).toEqual([
      'page-1.png',
      'page-2.png',
      'page-10.png',
    ])
    expect(naturalCompare('a.jpg', 'a.jpg')).toBe(0)
  })
})

describe('archive books', () => {
  it('analyses a CBZ and writes its pages', async () => {
    const db = await database()
    const pages = [await jpeg(40, 60), await jpeg(41, 61)]
    const path = writeBook(
      'v1.cbz',
      writeZip([
        { name: 'pages/2.jpg', data: pages[1]! },
        { name: 'pages/1.jpg', data: pages[0]! },
        { name: 'notes.txt', data: Buffer.from('not a page') },
      ]),
    )

    const result = await analyzeBook(db.db, 'B1', path, { analyzeDimensions: true })
    expect(result).toEqual({
      status: 'READY',
      mediaType: 'application/zip',
      pageCount: 2,
      comment: null,
    })

    const media = await db.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(media.page_count).toBe(2)
    expect(media.status).toBe('READY')

    const rows = await db.db.selectFrom('media_page').selectAll().orderBy('number').execute()
    // The archive lists page 2 first; the reader still gets them in order.
    expect(rows.map((row) => row.file_name)).toEqual(['pages/1.jpg', 'pages/2.jpg'])
    expect(rows[0]?.width).toBe(40)
    expect(rows[0]?.height).toBe(60)
    expect(rows[1]?.width).toBe(41)

    // Every entry is a resource, pages or not, which is what the file list is for.
    const files = await db.db.selectFrom('media_file').select('file_name').orderBy('file_name').execute()
    expect(files.map((row) => row.file_name)).toEqual(['notes.txt', 'pages/1.jpg', 'pages/2.jpg'])

    await db.close()
  })

  it('leaves dimensions out when the library does not ask for them', async () => {
    const db = await database()
    const path = writeBook('v1.cbz', writeZip([{ name: '1.jpg', data: await jpeg(30, 40) }]))

    await analyzeBook(db.db, 'B1', path, { analyzeDimensions: false })
    const row = await db.db.selectFrom('media_page').selectAll().executeTakeFirstOrThrow()
    expect(row.width).toBeNull()
    expect(row.height).toBeNull()
    // The page is still known, and so is its size.
    expect(row.file_size).toBeGreaterThan(0)

    await db.close()
  })

  it('records a file it cannot read instead of throwing', async () => {
    const db = await database()

    const broken = await analyzeBook(db.db, 'B1', writeBook('v1.cbz', Buffer.from('this is not a zip')), {})
    expect(broken.status).toBe('ERROR')
    expect(broken.comment).toContain('ERR_1005')

    const media = await db.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(media.status).toBe('ERROR')
    expect(media.page_count).toBe(0)

    // An archive format this server does not read is reported as unsupported,
    // which is a different thing from a broken file.
    const unsupported = await analyzeBook(db.db, 'B1', writeBook('v1.cb7', Buffer.from('7z bytes')), {})
    expect(unsupported.status).toBe('UNSUPPORTED')
    expect(unsupported.comment).toContain('ERR_1001')

    // Re-analysing a good file after a bad one clears the error.
    const good = writeBook('v1.cbz', writeZip([{ name: '1.jpg', data: await jpeg(10, 10) }]))
    const recovered = await analyzeBook(db.db, 'B1', good, {})
    expect(recovered.status).toBe('READY')
    const after = await db.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(after.comment).toBeNull()

    await db.close()
  })
})

describe('rar books', () => {
  it('reports a file that is not really a RAR', async () => {
    const db = await database()

    // A RAR has no writer available to build a fixture with, so what is covered
    // here is that the container is recognised, handed to the RAR reader, and its
    // refusal is recorded rather than thrown.
    const result = await analyzeBook(db.db, 'B1', writeBook('v1.cbr', Buffer.from('not a rar archive')), {})
    expect(result.status).toBe('ERROR')
    expect(result.comment).toContain('ERR_1005')

    const media = await db.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(media.status).toBe('ERROR')

    await db.close()
  })
})

describe('pdf books', () => {
  it('counts and renders the pages of a PDF', async () => {
    const db = await database()
    const path = writeBook('v1.pdf', minimalPdf())

    const result = await analyzeBook(db.db, 'B1', path, {})
    expect(result.status).toBe('READY')
    expect(result.mediaType).toBe('application/pdf')
    expect(result.pageCount).toBe(1)

    const pages = await db.db.selectFrom('media_page').selectAll().execute()
    expect(pages).toHaveLength(1)
    expect(pages[0]?.media_type).toBe('image/png')

    // The page is rendered lazily, and what comes back is a real PNG.
    const { openBook } = await import('./index.js')
    const book = await openBook(path)
    const bytes = await book.readPage(1)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await expect(book.readPage(2)).rejects.toThrow('out of range')
    book.close()

    await db.close()
  })
})

describe('epub books', () => {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const opf = (pages: string) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${pages}
  </manifest>
  <spine>${pages.includes('chapter') ? '<itemref idref="c1"/><itemref idref="c2"/>' : ''}${
    pages.includes('img1') ? '<itemref idref="img1"/><itemref idref="img2"/>' : ''
  }</spine>
</package>`

  const nav = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter1.xhtml">Chapter One</a></li>
    <li><a href="chapter2.xhtml">Chapter Two</a></li>
  </ol></nav></body>
</html>`

  it('reads the spine as pages and the navigation document as the table of contents', async () => {
    const db = await database()
    const path = writeBook(
      'v1.epub',
      writeZip([
        { name: 'mimetype', data: Buffer.from('application/epub+zip') },
        { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
        {
          name: 'OEBPS/content.opf',
          data: Buffer.from(
            opf(
              '<item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>',
            ),
          ),
        },
        { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav) },
        { name: 'OEBPS/chapter1.xhtml', data: Buffer.from('<html><body>one</body></html>') },
        { name: 'OEBPS/chapter2.xhtml', data: Buffer.from('<html><body>two</body></html>') },
      ]),
    )

    const result = await analyzeBook(db.db, 'B1', path, {})
    expect(result.status).toBe('READY')
    expect(result.mediaType).toBe('application/epub+zip')
    expect(result.pageCount).toBe(2)

    const pages = await db.db.selectFrom('media_page').selectAll().orderBy('number').execute()
    expect(pages.map((row) => row.file_name)).toEqual(['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml'])
    expect(pages[0]?.media_type).toBe('application/xhtml+xml')

    const toc = await db.db.selectFrom('epub_toc').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(JSON.parse(toc.toc)).toEqual([
      { title: 'Chapter One', href: 'OEBPS/chapter1.xhtml', children: [] },
      { title: 'Chapter Two', href: 'OEBPS/chapter2.xhtml', children: [] },
    ])

    // Positions place a reader in the book without a page number. Each chapter is
    // far shorter than one position, so it gets exactly one, and the second of the
    // two ends the book.
    const positions = await db.db
      .selectFrom('epub_positions')
      .selectAll()
      .where('book_id', '=', 'B1')
      .executeTakeFirstOrThrow()
    expect(JSON.parse(positions.positions)).toEqual([
      {
        href: 'OEBPS/chapter1.xhtml',
        type: 'application/xhtml+xml',
        koboSpan: 'kobo.1.1',
        locations: { progression: 0, position: 1, totalProgression: 0.5 },
      },
      {
        href: 'OEBPS/chapter2.xhtml',
        type: 'application/xhtml+xml',
        koboSpan: 'kobo.1.1',
        locations: { progression: 0, position: 2, totalProgression: 1 },
      },
    ])

    // A resource inside the book can be read by name, which the reader needs.
    const { openBook } = await import('./index.js')
    const book = await openBook(path)
    expect((await book.readResource('OEBPS/chapter1.xhtml')).toString()).toContain('one')
    expect(book.epub?.divinaCompatible).toBe(false)
    book.close()

    await db.close()
  })

  it('treats an image-only spine as Divina compatible', async () => {
    const db = await database()
    const path = writeBook(
      'v1.epub',
      writeZip([
        { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
        {
          name: 'OEBPS/content.opf',
          data: Buffer.from(
            opf(
              '<item id="img1" href="1.jpg" media-type="image/jpeg"/><item id="img2" href="2.jpg" media-type="image/jpeg"/>',
            ),
          ),
        },
        { name: 'OEBPS/1.jpg', data: await jpeg(20, 30) },
        { name: 'OEBPS/2.jpg', data: await jpeg(21, 31) },
      ]),
    )

    const result = await analyzeBook(db.db, 'B1', path, { analyzeDimensions: true })
    expect(result.pageCount).toBe(2)

    const { openBook } = await import('./index.js')
    const book = await openBook(path)
    expect(book.epub?.divinaCompatible).toBe(true)
    book.close()

    // Dimensions are read from the images, so a Divina book knows them.
    const pages = await db.db.selectFrom('media_page').selectAll().orderBy('number').execute()
    expect(pages[0]?.width).toBe(20)
    expect(pages[0]?.height).toBe(30)

    await db.close()
  })

  it('reports an EPUB with no spine as an error', async () => {
    const db = await database()
    const path = writeBook('v1.epub', writeZip([{ name: 'META-INF/container.xml', data: Buffer.from(containerXml) }]))

    const result = await analyzeBook(db.db, 'B1', path, {})
    expect(result.status).toBe('ERROR')

    await db.close()
  })
})
