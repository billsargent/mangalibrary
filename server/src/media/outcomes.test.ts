import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { scanLibrary } from '../scan/reconcile.js'
import { epubBuffer } from '../testing/epub.js'
import { writeRar } from '../testing/rar.js'
import { writeZip } from '../testing/zip.js'
import { analyzeBook } from './analyze.js'
import { inspectBook } from './inspect.js'

/**
 * What analysis says about a book it could not read, or could only partly read:
 * the reference's code for the reason, which the web UI has a sentence for.
 */

const folder = (): string => mkdtempSync(join(tmpdir(), 'ml-outcomes-'))
const sample = (name: string): string => fileURLToPath(new URL(`../testing/fixtures/rar/${name}`, import.meta.url))
const page = Buffer.from('a page, as far as an archive is concerned')

/** Write a file and say what analysis makes of it. */
async function outcome(name: string, content: Buffer | string): Promise<[string, string | null]> {
  const path = join(folder(), name)
  writeFileSync(path, content)
  const inspection = await inspectBook(path)
  return [inspection.status, inspection.comment]
}

describe('a book that cannot be read says why', () => {
  it('has no pages: an archive with nothing in it that is a picture', async () => {
    expect(await outcome('notes.cbz', writeZip([{ name: 'readme.txt', data: Buffer.from('no pictures') }]))).toEqual([
      'ERROR',
      'ERR_1006',
    ])
    expect(await outcome('empty.cbz', writeZip([]))).toEqual(['ERROR', 'ERR_1006'])
    expect(await outcome('notes.cbr', writeRar([{ name: 'readme.txt', data: Buffer.from('no pictures') }]))).toEqual([
      'ERROR',
      'ERR_1006',
    ])
  })

  it('is ready, and has nothing to say, when it has a page among other things', async () => {
    const book = writeZip([
      { name: '1.jpg', data: page },
      { name: 'readme.txt', data: Buffer.from('and a note') },
    ])
    expect(await outcome('book.cbz', book)).toEqual(['READY', null])
  })

  it('is not there', async () => {
    const inspection = await inspectBook(join(folder(), 'gone.cbz'))
    expect([inspection.status, inspection.comment]).toEqual(['ERROR', 'ERR_1018'])
    const epub = await inspectBook(join(folder(), 'gone.epub'))
    expect([epub.status, epub.comment]).toEqual(['ERROR', 'ERR_1018'])
  })

  it('is a RAR that needs a password, or one of a set of volumes', async () => {
    for (const name of ['FileEncByName.rar', 'HeaderEnc1234.rar']) {
      const path = join(folder(), 'locked.cbr')
      copyFileSync(sample(name), path)
      const inspection = await inspectBook(path)
      expect([name, inspection.status, inspection.comment]).toEqual([name, 'UNSUPPORTED', 'ERR_1002'])
    }
    expect(await outcome('part1.cbr', writeRar([{ name: '1.jpg', data: page }], { volume: true }))).toEqual([
      'UNSUPPORTED',
      'ERR_1004',
    ])
  })

  it('is named as an EPUB and is not one', async () => {
    expect(await outcome('pictures.epub', writeZip([{ name: '1.jpg', data: page }]))).toEqual(['ERROR', 'ERR_1032'])
    expect(await outcome('text.epub', 'this was never a zip')).toEqual(['ERROR', 'ERR_1032'])
  })

  it('keeps the error’s own words when the reference has no code for it', async () => {
    const [status, comment] = await outcome('broken.cbz', 'this was never a zip')
    expect(status).toBe('ERROR')
    expect(comment).toMatch(/^ERR_1005 \S/)
    expect(await outcome('notes.txt', 'not a book')).toEqual([
      'UNSUPPORTED',
      'ERR_1001 notes.txt is not a book container this server reads',
    ])
  })
})

describe('an EPUB that was read, with parts that were not found', () => {
  it('is ready, and says what is missing', async () => {
    const epub = epubBuffer(
      '<dc:title>A book</dc:title>',
      {},
      {
        manifest:
          '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>' +
          '<item id="art" href="images/missing.png" media-type="image/png"/>',
      },
    )
    expect(await outcome('book.epub', epub)).toEqual([
      'READY',
      'ERR_1035 ERR_1033 [OEBPS/images/missing.png, OEBPS/nav.xhtml]',
    ])
  })

  it('has nothing to say when everything it names is there', async () => {
    expect(await outcome('book.epub', epubBuffer('<dc:title>A book</dc:title>'))).toEqual(['READY', null])
  })
})

describe('what is written down', () => {
  it('is an error for a book with no pages, and the remark for a book that was read', async () => {
    const root = folder()
    mkdirSync(join(root, 'Series'))
    writeFileSync(
      join(root, 'Series', 'a notes.cbz'),
      writeZip([{ name: 'readme.txt', data: Buffer.from('no pictures') }]),
    )
    writeFileSync(
      join(root, 'Series', 'b book.epub'),
      epubBuffer(
        '<dc:title>A book</dc:title>',
        {},
        { manifest: '<item id="art" href="missing.png" media-type="image/png"/>' },
      ),
    )

    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const db = database.db
    await db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'Main', root, created_date: 'now', last_modified_date: 'now' } as never)
      .execute()
    await scanLibrary(db, 'L1')

    const books = await db.selectFrom('books').select(['id', 'url']).orderBy('name').execute()
    for (const book of books) await analyzeBook(db, book.id, fileURLToPath(book.url))

    const media = await db
      .selectFrom('media')
      .innerJoin('books', 'books.id', 'media.book_id')
      .select(['books.name', 'media.status', 'media.comment', 'media.page_count'])
      .orderBy('books.name')
      .execute()
    expect(media).toEqual([
      { name: 'a notes', status: 'ERROR', comment: 'ERR_1006', page_count: 0 },
      { name: 'b book', status: 'READY', comment: 'ERR_1033 [OEBPS/missing.png]', page_count: 1 },
    ])
  })
})
