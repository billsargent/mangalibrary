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
import { writeRar } from '../testing/rar.js'
import { writeZip } from '../testing/zip.js'
import { openBook } from './index.js'

// ------------------------------------------------------------------- fixtures

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
  it('reads a RAR named .cbz, and a ZIP named .cbr, by what they are', async () => {
    const db = await database()
    const rarNamedZip = writeBook('renamed.cbz', writeRar([{ name: 'page 1.jpg', data: await jpeg(10, 20) }]))
    const zipNamedRar = writeBook('renamed.cbr', writeZip([{ name: 'page 1.jpg', data: await jpeg(10, 20) }]))

    expect((await analyzeBook(db.db, 'B1', rarNamedZip, { analyzeDimensions: true })).status).toBe('READY')
    const media = await db.db
      .selectFrom('media')
      .select('media_type')
      .where('book_id', '=', 'B1')
      .executeTakeFirstOrThrow()
    expect(media.media_type).toContain('rar')

    for (const path of [rarNamedZip, zipNamedRar]) {
      const book = await openBook(path)
      try {
        expect((await sharp(await book.readPage(1)).metadata()).width).toBe(10)
      } finally {
        book.close()
      }
    }
  })

  it('lists and measures the pages of a CBR, in reading order', async () => {
    const db = await database()
    const path = writeBook(
      'v1.cbr',
      writeRar([
        { name: 'page 10.jpg', data: await jpeg(30, 40) },
        { name: 'page 2.jpg', data: await jpeg(20, 30) },
        { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>From a RAR</Title></ComicInfo>') },
        { name: 'page 1.jpg', data: await jpeg(10, 20) },
      ]),
    )

    const result = await analyzeBook(db.db, 'B1', path, { analyzeDimensions: true })
    expect(result.status).toBe('READY')

    const media = await db.db.selectFrom('media').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
    expect(media).toMatchObject({ status: 'READY', page_count: 3 })
    expect(media.media_type).toContain('rar')

    const pages = await db.db
      .selectFrom('media_page')
      .select(['number', 'file_name', 'width', 'height'])
      .where('book_id', '=', 'B1')
      .orderBy('number')
      .execute()
    expect(pages).toEqual([
      { number: 1, file_name: 'page 1.jpg', width: 10, height: 20 },
      { number: 2, file_name: 'page 2.jpg', width: 20, height: 30 },
      { number: 3, file_name: 'page 10.jpg', width: 30, height: 40 },
    ])

    // And a page comes out as the image that went in.
    const book = await openBook(path)
    try {
      const second = await sharp(await book.readPage(2)).metadata()
      expect([second.width, second.height]).toEqual([20, 30])
      expect((await book.readResource('ComicInfo.xml')).toString()).toContain('From a RAR')
    } finally {
      book.close()
    }

    await db.close()
  })

  it('reports a file that is not really a RAR', async () => {
    const db = await database()

    // The container is recognised by its name, handed to the RAR reader, and its
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
    expect(pages[0]?.media_type).toBe('image/jpeg')
    // Its size is known from the page's size on paper, without being asked for.
    expect(Math.max(pages[0]?.width ?? 0, pages[0]?.height ?? 0)).toBe(1600)

    // The page is drawn when it is read, and what comes back is a real JPEG.
    const { openBook } = await import('./index.js')
    const book = await openBook(path)
    const bytes = await book.readPage(1)
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
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
