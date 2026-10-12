import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { minimalPdf } from '../spikes/minimalPdf.js'
import { extendedFileName } from '../testing/headers.js'
import { writeZip } from '../testing/zip.js'

const READER_KEY = 'reader-key'
const reader = { 'x-api-key': READER_KEY }
const anonymous = {}

// ---------------------------------------------------------------- zip fixture

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`

const nav = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter1.xhtml">Chapter One</a></li>
    <li><a href="chapter2.xhtml">Chapter Two</a></li>
  </ol></nav></body>
</html>`

/** A two-chapter EPUB with a stylesheet, an image and a font alongside the text. */
async function epub(): Promise<Buffer> {
  return writeZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav) },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from('<html><body>first chapter</body></html>') },
    { name: 'OEBPS/chapter2.xhtml', data: Buffer.from('<html><body>second chapter</body></html>') },
    { name: 'OEBPS/第一章.xhtml', data: Buffer.from('<html><body>afterword</body></html>') },
    { name: 'OEBPS/style.css', data: Buffer.from('body { color: black }') },
    { name: 'OEBPS/1.jpg', data: await jpeg(8, 8) },
    { name: 'OEBPS/book.ttf', data: Buffer.from('fontdata') },
  ])
}

/**
 * Fixture:
 *
 * - B1 is a CBZ (Divina), B2 a PDF, B3 an EPUB with two chapters, and B4 an EPUB
 *   in a library the reader cannot see. Each has a real file except B4.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-manifest-root-'))
  const otherRoot = mkdtempSync(join(tmpdir(), 'ml-manifest-other-'))

  writeFileSync(
    join(root, 'Volume 1.cbz'),
    writeZip([
      { name: '1.jpg', data: await jpeg(800, 1200) },
      { name: '2.jpg', data: await jpeg(400, 600) },
    ]),
  )
  writeFileSync(join(root, 'Story.pdf'), minimalPdf())
  writeFileSync(join(root, 'Book.epub'), await epub())

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-manifest-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('users')
    .values({
      id: 'U1',
      email: 'reader@example.com',
      password: hashPassword('reader-pass'),
      roles: JSON.stringify(['PAGE_STREAMING', 'FILE_DOWNLOAD']),
      shared_all_libraries: 0,
      age_restriction: null,
      age_restriction_allow_only: null,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('user_api_keys')
    .values({ id: 'K1', user_id: 'U1', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now })
    .execute()

  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Other', root: otherRoot, created_date: now, last_modified_date: now },
    ])
    .execute()
  await db.insertInto('user_library_sharing').values({ user_id: 'U1', library_id: 'L1' }).execute()

  await db
    .insertInto('series')
    .values([
      {
        id: 'S1',
        library_id: 'L1',
        name: 'Akira',
        url: 'akira',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S2',
        library_id: 'L2',
        name: 'Hidden',
        url: 'hidden',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()
  await db
    .insertInto('series_metadata')
    .values([
      {
        series_id: 'S1',
        status: 'ONGOING',
        title: 'Akira',
        title_sort: 'Akira',
        language: 'en',
        reading_direction: 'RIGHT_TO_LEFT',
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        status: 'ONGOING',
        title: 'Hidden',
        title_sort: 'Hidden',
        language: '',
        reading_direction: null,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  const book = (id: string, seriesId: string, url: string, name: string) => ({
    id,
    series_id: seriesId,
    library_id: seriesId === 'S2' ? 'L2' : 'L1',
    name,
    url,
    file_last_modified: now,
    file_size: 100,
    number: 1,
    created_date: now,
    last_modified_date: now,
  })
  await db
    .insertInto('books')
    .values([
      book('B1', 'S1', 'Volume 1.cbz', 'Volume 1'),
      book('B2', 'S1', 'Story.pdf', 'Story'),
      book('B3', 'S1', 'Book.epub', 'Book'),
      book('B4', 'S2', 'Hidden.epub', 'Hidden'),
    ])
    .execute()

  const bookMeta = (
    bookId: string,
    title: string,
    numberSort: number,
    extra: { summary?: string; isbn?: string; release_date?: string | null } = {},
  ) => ({
    book_id: bookId,
    title,
    number: String(numberSort),
    number_sort: numberSort,
    summary: '',
    isbn: '',
    release_date: null as string | null,
    ...extra,
    created_date: now,
    last_modified_date: now,
  })
  await db
    .insertInto('book_metadata')
    .values([
      bookMeta('B1', 'Akira Volume One', 1, {
        summary: 'A summary',
        isbn: '9781234567897',
        release_date: '2020-05-04T00:00:00Z',
      }),
      bookMeta('B2', 'Akira Volume Two', 2),
      bookMeta('B3', 'Akira Volume Three', 3),
      bookMeta('B4', 'Hidden Volume One', 1),
    ])
    .execute()
  await db.insertInto('book_metadata_author').values({ book_id: 'B1', name: 'Katsuhiro', role: 'author' }).execute()
  await db
    .insertInto('book_metadata_author')
    .values({ book_id: 'B1', name: 'A Translator', role: 'translator' })
    .execute()
  await db.insertInto('book_metadata_author').values({ book_id: 'B1', name: 'A Letterer', role: 'letterer' }).execute()
  await db.insertInto('book_metadata_tag').values({ book_id: 'B1', tag: 'cyberpunk' }).execute()

  await db
    .insertInto('media')
    .values([
      {
        book_id: 'B1',
        media_type: 'application/zip',
        status: 'READY',
        comment: null,
        page_count: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        media_type: 'application/pdf',
        status: 'READY',
        comment: null,
        page_count: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        media_type: 'application/epub+zip',
        status: 'READY',
        comment: null,
        page_count: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B4',
        media_type: 'application/epub+zip',
        status: 'READY',
        comment: null,
        page_count: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('media_page')
    .values([
      {
        book_id: 'B1',
        number: 1,
        file_name: '1.jpg',
        media_type: 'image/jpeg',
        width: 800,
        height: 1200,
        file_size: 1024,
      },
      {
        book_id: 'B1',
        number: 2,
        file_name: '2.jpg',
        media_type: 'image/jpeg',
        width: 400,
        height: 600,
        file_size: 512,
      },
      {
        book_id: 'B2',
        number: 1,
        file_name: '1.png',
        media_type: 'image/png',
        width: 200,
        height: 300,
        file_size: null,
      },
      {
        book_id: 'B3',
        number: 1,
        file_name: 'OEBPS/chapter1.xhtml',
        media_type: 'application/xhtml+xml',
        width: null,
        height: null,
        file_size: 40,
      },
      {
        book_id: 'B3',
        number: 2,
        file_name: 'OEBPS/chapter2.xhtml',
        media_type: 'application/xhtml+xml',
        width: null,
        height: null,
        file_size: 41,
      },
    ])
    .execute()

  const file = (bookId: string, file_name: string) => ({ book_id: bookId, file_name })
  await db
    .insertInto('media_file')
    .values([
      file('B3', 'OEBPS/chapter1.xhtml'),
      file('B3', 'OEBPS/chapter2.xhtml'),
      file('B3', 'OEBPS/nav.xhtml'),
      file('B3', 'OEBPS/style.css'),
      file('B3', 'OEBPS/1.jpg'),
      file('B3', 'OEBPS/book.ttf'),
    ])
    .execute()

  await db
    .insertInto('epub_toc')
    .values({
      book_id: 'B3',
      toc: JSON.stringify([
        { title: 'Chapter One', href: 'OEBPS/chapter1.xhtml', children: [] },
        { title: 'Chapter Two', href: 'OEBPS/chapter2.xhtml', children: [] },
      ]),
    })
    .execute()

  await db
    .insertInto('epub_positions')
    .values({
      book_id: 'B3',
      positions: JSON.stringify([
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
      ]),
    })
    .execute()

  await db
    .insertInto('thumbnails')
    .values({
      id: 'T1',
      owner_type: 'BOOK',
      owner_id: 'B1',
      type: 'GENERATED',
      page: 1,
      selected: 1,
      media_type: 'image/png',
      width: 4,
      height: 6,
      file_size: 70,
      thumbnail: await jpeg(4, 6),
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

interface Link {
  rel?: string
  href?: string
  type?: string
  width?: number
  height?: number
}

interface Publication {
  context: string
  metadata: Record<string, unknown>
  links: Link[]
  images: unknown[]
  readingOrder: Link[]
  resources: Link[]
  toc: { title?: string; href?: string }[]
  landmarks: unknown[]
  pageList: unknown[]
}

describe('book manifests', () => {
  it('describes a Divina book as a page-per-page publication', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/manifest', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/divina+json')

    const manifest = res.json() as Publication
    expect(manifest.context).toBe('https://readium.org/webpub-manifest/context.jsonld')
    expect(manifest.metadata.title).toBe('Akira Volume One')
    expect(manifest.metadata.conformsTo).toBe('https://readium.org/webpub-manifest/profiles/divina')
    expect(manifest.metadata.numberOfPages).toBe(2)
    expect(manifest.metadata.language).toBe('en')
    expect(manifest.metadata.readingProgression).toBe('rtl')
    expect(manifest.metadata.description).toBe('A summary')
    expect(manifest.metadata.identifier).toBe('urn:isbn:9781234567897')
    expect(manifest.metadata.published).toBe('2020-05-04')
    expect(manifest.metadata.author).toEqual(['Katsuhiro'])
    expect(manifest.metadata.translator).toEqual(['A Translator'])
    expect(manifest.metadata.letterer).toEqual(['A Letterer'])
    expect(manifest.metadata.subject).toEqual(['cyberpunk'])
    expect(manifest.metadata.belongsTo).toEqual({ series: [{ name: 'Akira', position: 1 }] })

    const self = manifest.links.find((link) => link.rel === 'self')
    expect(self?.href).toContain('/api/v1/books/B1/manifest')
    expect(self?.type).toBe('application/divina+json')
    const acquisition = manifest.links.find((link) => link.rel === 'http://opds-spec.org/acquisition')
    expect(acquisition?.type).toBe('application/vnd.comicbook+zip')
    expect(acquisition?.href).toContain('/api/v1/books/B1/file')

    expect(manifest.readingOrder).toHaveLength(2)
    expect(manifest.readingOrder[0]?.href).toContain('/api/v1/books/B1/pages/1?contentNegotiation=false')
    expect(manifest.readingOrder[0]?.type).toBe('image/jpeg')
    expect(manifest.readingOrder[0]?.width).toBe(800)
    expect(manifest.readingOrder[1]?.href).toContain('/pages/2')

    // The poster rides along as a resource, with the type it is stored in.
    expect(manifest.resources).toEqual([
      { href: expect.stringContaining('/api/v1/books/B1/thumbnail'), type: 'image/png' },
    ])
    // The empty sections are present, as the reference sends them.
    expect(manifest.images).toEqual([])
    expect(manifest.toc).toEqual([])
    expect(manifest.landmarks).toEqual([])
    expect(manifest.pageList).toEqual([])

    await app.close()
  })

  it('describes a PDF as a page-per-page publication that points at page images', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B2/manifest', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/webpub+json')

    const manifest = res.json() as Publication
    expect(manifest.metadata.conformsTo).toBe('https://readium.org/webpub-manifest/profiles/pdf')
    expect(manifest.readingOrder).toEqual([
      {
        href: expect.stringContaining('/api/v1/books/B2/pages/1'),
        type: 'image/png',
        width: 200,
        height: 300,
      },
    ])
    // A PDF can also be read through the Divina profile.
    expect(manifest.links.some((link) => link.type === 'application/divina+json')).toBe(true)

    await app.close()
  })

  it('describes an EPUB by its spine, assets and table of contents', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B3/manifest', headers: reader })
    expect(res.statusCode).toBe(200)
    const manifest = res.json() as Publication

    expect(manifest.metadata.conformsTo).toBe('https://readium.org/webpub-manifest/profiles/epub')
    expect(manifest.readingOrder).toEqual([
      {
        href: expect.stringContaining('/api/v1/books/B3/resource/OEBPS/chapter1.xhtml'),
        type: 'application/xhtml+xml',
      },
      {
        href: expect.stringContaining('/api/v1/books/B3/resource/OEBPS/chapter2.xhtml'),
        type: 'application/xhtml+xml',
      },
    ])

    // Assets are every file that is not part of the spine, plus the poster.
    const resourceHrefs = manifest.resources.map((link) => link.href ?? '')
    expect(resourceHrefs.some((href) => href.endsWith('/resource/OEBPS/style.css'))).toBe(true)
    expect(resourceHrefs.some((href) => href.endsWith('/resource/OEBPS/1.jpg'))).toBe(true)
    expect(resourceHrefs.some((href) => href.endsWith('/resource/OEBPS/book.ttf'))).toBe(true)
    expect(resourceHrefs.some((href) => href.endsWith('/resource/OEBPS/chapter1.xhtml'))).toBe(false)
    expect(resourceHrefs.some((href) => href.includes('/books/B3/thumbnail'))).toBe(true)

    expect(manifest.toc.map((entry) => entry.title)).toEqual(['Chapter One', 'Chapter Two'])
    expect(manifest.toc[0]?.href).toContain('/api/v1/books/B3/resource/OEBPS/chapter1.xhtml')

    await app.close()
  })

  it('refuses a profile a book does not have, and books that are missing or unseen', async () => {
    const { app } = await setup()

    const wrongProfile = await app.inject({ method: 'GET', url: '/api/v1/books/B1/manifest/pdf', headers: reader })
    expect(wrongProfile.statusCode).toBe(400)
    expect((wrongProfile.json() as { message: string }).message).toContain('not compatible with requested profile')

    const epubOfDivina = await app.inject({ method: 'GET', url: '/api/v1/books/B1/manifest/epub', headers: reader })
    expect(epubOfDivina.statusCode).toBe(400)

    // /manifest/divina works for any book, as the reference allows.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/books/B2/manifest/divina', headers: reader })).statusCode,
    ).toBe(200)

    expect((await app.inject({ method: 'GET', url: '/api/v1/books/NOPE/manifest', headers: reader })).statusCode).toBe(
      404,
    )

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/books/B4/manifest', headers: reader })
    expect(hidden.statusCode).toBe(403)

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/books/B1/manifest', headers: anonymous })
    expect(unauthenticated.statusCode).toBe(401)

    await app.close()
  })
})

describe('book resources', () => {
  it('serves a file from inside an EPUB, and refuses anything that is not one', async () => {
    const { app } = await setup()

    const chapter = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B3/resource/OEBPS/chapter1.xhtml',
      headers: reader,
    })
    expect(chapter.statusCode).toBe(200)
    expect(chapter.headers['content-type']).toBe('application/xhtml+xml')
    expect(chapter.headers['content-security-policy']).toBe("script-src 'none'; object-src 'none';")
    expect(chapter.headers['content-disposition']).toContain('chapter1.xhtml')
    expect(chapter.body).toContain('first chapter')

    const css = await app.inject({ method: 'GET', url: '/api/v1/books/B3/resource/OEBPS/style.css', headers: reader })
    expect(css.statusCode).toBe(200)
    expect(css.headers['content-type']).toBe('text/css')

    // A book that is not an EPUB has no resources to serve.
    const wrongProfile = await app.inject({ method: 'GET', url: '/api/v1/books/B1/resource/1.jpg', headers: reader })
    expect(wrongProfile.statusCode).toBe(400)

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B3/resource/OEBPS/nope.css',
      headers: reader,
    })
    expect(missing.statusCode).toBe(404)

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/books/B4/resource/OEBPS/a.css', headers: reader })
    expect(hidden.statusCode).toBe(403)

    await app.close()
  })

  it('serves a font without credentials but not any other file', async () => {
    const { app } = await setup()

    const font = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B3/resource/OEBPS/book.ttf',
      headers: anonymous,
    })
    expect(font.statusCode).toBe(200)
    expect(font.headers['content-type']).toBe('font/ttf')
    expect(font.body).toBe('fontdata')

    const chapter = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B3/resource/OEBPS/chapter1.xhtml',
      headers: anonymous,
    })
    expect(chapter.statusCode).toBe(401)

    await app.close()
  })

  it('revalidates a resource with last-modified', async () => {
    const { app } = await setup()

    const first = await app.inject({ method: 'GET', url: '/api/v1/books/B3/resource/OEBPS/style.css', headers: reader })
    const lastModified = first.headers['last-modified'] as string
    expect(lastModified).toBeTruthy()

    const cached = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B3/resource/OEBPS/style.css',
      headers: { ...reader, 'if-modified-since': lastModified },
    })
    expect(cached.statusCode).toBe(304)

    await app.close()
  })
})

describe('book positions', () => {
  it('returns the positions analysis recorded, and nothing for a book without them', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B3/positions', headers: reader })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { positions: { href: string; locations: { position: number } }[]; total: number }
    expect(body.total).toBe(2)
    expect(body.positions.map((position) => position.href)).toEqual(['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml'])
    expect(body.positions[1]?.locations.position).toBe(2)

    // A book that is not an EPUB has no positions at all.
    const divina = await app.inject({ method: 'GET', url: '/api/v1/books/B1/positions', headers: reader })
    expect(divina.json()).toEqual({ positions: [], total: 0 })

    await app.close()
  })
})

describe('an EPUB resource whose name a header cannot carry as it is', () => {
  it('is still served, under its own name', async () => {
    const { app, database } = await setup()
    await database.db.insertInto('media_file').values({ book_id: 'B3', file_name: 'OEBPS/第一章.xhtml' }).execute()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/books/B3/resource/OEBPS/${encodeURIComponent('第一章.xhtml')}`,
      headers: reader,
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('afterword')
    expect(extendedFileName(res.headers['content-disposition'])).toBe('第一章.xhtml')

    await app.close()
  })
})
