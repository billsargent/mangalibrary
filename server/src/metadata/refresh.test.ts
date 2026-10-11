import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { analyzeBook } from '../media/analyze.js'
import { writeZip } from '../testing/zip.js'
import { refreshBookMetadata } from './refresh.js'

/** A page is a page by its extension; nothing here decodes one. */
const PAGE = Buffer.from('a page')

function comicInfo(fields: Record<string, string>): string {
  const elements = Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?><ComicInfo>${elements}</ComicInfo>`
}

const FULL = comicInfo({
  Title: 'Akira Volume 1',
  Summary: 'Neo-Tokyo.',
  Number: '1',
  Year: '1984',
  Month: '12',
  Day: '6',
  Writer: 'Katsuhiro Otomo',
  Penciller: 'Katsuhiro Otomo',
  Tags: 'Cyberpunk, Action',
  Web: 'https://example.org/akira',
  GTIN: '978-1-56619-909-4',
})

interface Fixture {
  database: Database
  root: string
  path: string
}

interface SetupOptions {
  /** The document to put in the book; null leaves the book without one. */
  document?: string | null
  /** Columns to override on the library row. */
  library?: Record<string, unknown>
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'ml-metadata-'))
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  await database.db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      created_date: now,
      last_modified_date: now,
      ...options.library,
    } as never)
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

  const entries = [{ name: 'page1.jpg', data: PAGE }]
  const document = options.document === undefined ? FULL : options.document
  if (document !== null) entries.push({ name: 'ComicInfo.xml', data: Buffer.from(document, 'utf8') })

  const path = join(root, 'Volume 1.cbz')
  writeFileSync(path, writeZip(entries))

  await database.db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: pathToFileURL(path).href,
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('book_metadata')
    .values({ book_id: 'B1', title: 'Volume 1', created_date: now, last_modified_date: now })
    .execute()

  return { database, root, path }
}

async function metadata(database: Database) {
  return database.db.selectFrom('book_metadata').selectAll().where('book_id', '=', 'B1').executeTakeFirstOrThrow()
}

async function authors(database: Database) {
  return database.db
    .selectFrom('book_metadata_author')
    .select(['name', 'role'])
    .where('book_id', '=', 'B1')
    .orderBy('role')
    .orderBy('name')
    .execute()
}

async function tags(database: Database) {
  return database.db.selectFrom('book_metadata_tag').select('tag').where('book_id', '=', 'B1').orderBy('tag').execute()
}

async function links(database: Database) {
  return database.db.selectFrom('book_metadata_link').select(['label', 'url']).where('book_id', '=', 'B1').execute()
}

describe('refreshing a book from its own file', () => {
  it('writes what the document says into the metadata tables', async () => {
    const { database } = await setup()

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('changed')
    expect(result.reason).toBeNull()
    expect(result.changed.sort()).toEqual(
      ['authors', 'isbn', 'links', 'number', 'numberSort', 'releaseDate', 'summary', 'tags', 'title'].sort(),
    )

    const row = await metadata(database)
    expect(row.title).toBe('Akira Volume 1')
    expect(row.summary).toBe('Neo-Tokyo.')
    expect(row.number).toBe('1')
    expect(row.number_sort).toBe(1)
    expect(row.release_date).toBe('1984-12-06')
    expect(row.isbn).toBe('9781566199094')

    expect(await authors(database)).toEqual([
      { name: 'Katsuhiro Otomo', role: 'penciller' },
      { name: 'Katsuhiro Otomo', role: 'writer' },
    ])
    expect((await tags(database)).map((row) => row.tag)).toEqual(['action', 'cyberpunk'])
    expect(await links(database)).toEqual([{ label: 'example.org', url: 'https://example.org/akira' }])
  })

  it('changes nothing the second time, and nothing about the timestamps', async () => {
    const { database } = await setup()

    await refreshBookMetadata(database.db, 'B1')
    const before = await metadata(database)

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('unchanged')
    expect(result.changed).toEqual([])

    const after = await metadata(database)
    expect(after.last_modified_date).toBe(before.last_modified_date)
  })

  it('leaves a locked field alone and applies the rest', async () => {
    const { database } = await setup()
    await database.db.updateTable('book_metadata').set({ title_lock: 1 }).where('book_id', '=', 'B1').execute()

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('changed')
    expect(result.changed).not.toContain('title')

    const row = await metadata(database)
    expect(row.title).toBe('Volume 1')
    expect(row.summary).toBe('Neo-Tokyo.')
  })

  it('leaves a locked list alone', async () => {
    const { database } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('book_metadata_author')
      .values({ book_id: 'B1', name: 'A Hand Written Credit', role: 'writer' })
      .execute()
    await database.db
      .updateTable('book_metadata')
      .set({ authors_lock: 1, last_modified_date: now })
      .where('book_id', '=', 'B1')
      .execute()

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.changed).not.toContain('authors')
    expect(await authors(database)).toEqual([{ name: 'A Hand Written Credit', role: 'writer' }])
  })

  it('replaces a list rather than merging into it', async () => {
    const { database, path } = await setup({ document: comicInfo({ Writer: 'One, Two' }) })
    await refreshBookMetadata(database.db, 'B1')
    expect((await authors(database)).map((row) => row.name)).toEqual(['One', 'Two'])

    // The credits in the file change; the book should follow, not accumulate.
    writeFileSync(
      path,
      writeZip([
        { name: 'page1.jpg', data: PAGE },
        { name: 'ComicInfo.xml', data: Buffer.from(comicInfo({ Writer: 'Two' }), 'utf8') },
      ]),
    )

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('changed')
    expect((await authors(database)).map((row) => row.name)).toEqual(['Two'])
  })

  it('imports nothing when the library is set not to', async () => {
    const { database } = await setup({ library: { import_comic_info_book: 0 } })

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('does not import')
    expect((await metadata(database)).title).toBe('Volume 1')
  })

  it('skips a book that carries no document', async () => {
    const { database } = await setup({ document: null })

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('ComicInfo.xml')
  })

  it('reports a file it cannot read instead of throwing', async () => {
    const { database, path } = await setup({ document: null })
    writeFileSync(path, Buffer.from('this is not a container'))

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('failed')
    expect(result.reason).not.toBeNull()
  })

  it('skips a book whose file is gone', async () => {
    const { database, path } = await setup()
    writeFileSync(path, Buffer.alloc(0))
    await database.db
      .updateTable('books')
      .set({ url: pathToFileURL(join(tmpdir(), 'nowhere', 'gone.cbz')).href })
      .where('id', '=', 'B1')
      .execute()

    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('the file is not there')
  })

  it('refuses a file outside the library root', async () => {
    const { database } = await setup()
    const outside = join(tmpdir(), 'ml-metadata-outside.cbz')
    writeFileSync(outside, writeZip([{ name: 'ComicInfo.xml', data: Buffer.from(FULL, 'utf8') }]))
    await database.db.updateTable('books').set({ url: outside }).where('id', '=', 'B1').execute()

    // A row that points outside the library is not followed, however it got there.
    const result = await refreshBookMetadata(database.db, 'B1')
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('the file is not there')
    expect((await metadata(database)).title).toBe('Volume 1')
  })

  it('applies only the fields the caller asked for', async () => {
    const { database } = await setup()

    const result = await refreshBookMetadata(database.db, 'B1', { capabilities: ['TITLE'] })
    expect(result.changed).toEqual(['title'])

    const row = await metadata(database)
    expect(row.title).toBe('Akira Volume 1')
    expect(row.summary).toBe('')
    expect(row.number).toBe('')
  })

  it('runs as part of analysing a book', async () => {
    const { database, path } = await setup({ document: null })

    // The book is analysed without a document, then the document appears.
    await analyzeBook(database.db, 'B1', path, {})
    expect((await metadata(database)).title).toBe('Volume 1')

    writeFileSync(
      path,
      writeZip([
        { name: 'page1.jpg', data: PAGE },
        { name: 'ComicInfo.xml', data: Buffer.from(FULL, 'utf8') },
      ]),
    )
    await analyzeBook(database.db, 'B1', path, {})

    const row = await metadata(database)
    expect(row.title).toBe('Akira Volume 1')
    expect(row.release_date).toBe('1984-12-06')
    expect(await authors(database)).toHaveLength(2)
  })
})
