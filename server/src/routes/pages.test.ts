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
import { writeZip } from '../testing/zip.js'

const READER_KEY = 'reader-key'
const reader = { 'x-api-key': READER_KEY }

// ---------------------------------------------------------------- zip fixture

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

/**
 * Fixture:
 *
 * - B1 (ZIP, ready) with two image pages of known sizes, B2 (PDF, ready) with one
 *   rendered page, B3 (EPUB, ready) whose page is markup, B4 with no analysis at
 *   all, B5 analysed as unsupported, and B6 in a library the reader cannot see.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-pages-root-'))
  const otherRoot = mkdtempSync(join(tmpdir(), 'ml-pages-other-'))

  writeFileSync(
    join(root, 'Volume 1.cbz'),
    writeZip([
      { name: 'pages/1.jpg', data: await jpeg(800, 1200) },
      { name: 'pages/2.jpg', data: await jpeg(400, 600) },
    ]),
  )
  writeFileSync(join(root, 'Story.pdf'), minimalPdf())
  writeFileSync(join(otherRoot, 'Hidden.cbz'), writeZip([{ name: '1.jpg', data: await jpeg(10, 10) }]))

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-pages-config-')),
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
      book('B3', 'S1', 'Text.epub', 'Text'),
      book('B4', 'S1', 'Unanalysed.cbz', 'Unanalysed'),
      book('B5', 'S1', 'Broken.cbz', 'Broken'),
      book('B6', 'S2', 'Hidden.cbz', 'Hidden'),
    ])
    .execute()

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
        page_count: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B5',
        media_type: null,
        status: 'UNSUPPORTED',
        comment: 'ERR_1001',
        page_count: 0,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B6',
        media_type: 'application/zip',
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
        file_name: 'pages/1.jpg',
        media_type: 'image/jpeg',
        width: 800,
        height: 1200,
        file_size: 1024,
      },
      {
        book_id: 'B1',
        number: 2,
        file_name: 'pages/2.jpg',
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
      { book_id: 'B6', number: 1, file_name: '1.jpg', media_type: 'image/jpeg', width: 10, height: 10, file_size: 60 },
    ])
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('book page images', () => {
  it('serves the page image with an inline file name', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['content-disposition']).toContain('Volume 1-1.jpeg')
    // A real image, not the stored bytes of some other page.
    const metadata = await sharp(res.rawPayload).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(800)
    expect(metadata.height).toBe(1200)

    const second = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/2', headers: reader })
    expect((await sharp(second.rawPayload).metadata()).width).toBe(400)

    await app.close()
  })

  it('converts the image on request, and refuses a format it does not know', async () => {
    const { app } = await setup()

    const png = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1?convert=png', headers: reader })
    expect(png.statusCode).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')
    expect(png.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    // Converting to the format the page is already in leaves it alone.
    const same = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1?convert=jpeg', headers: reader })
    expect(same.statusCode).toBe(200)
    expect(same.headers['content-type']).toBe('image/jpeg')

    const invalid = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1?convert=bmp', headers: reader })
    expect(invalid.statusCode).toBe(400)

    await app.close()
  })

  it('renders a PDF page, and refuses a page of a text EPUB', async () => {
    const { app } = await setup()

    const pdf = await app.inject({ method: 'GET', url: '/api/v1/books/B2/pages/1', headers: reader })
    expect(pdf.statusCode).toBe(200)
    // Our PDF reader renders each page to PNG.
    expect(pdf.headers['content-type']).toBe('image/png')
    expect(pdf.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const epub = await app.inject({ method: 'GET', url: '/api/v1/books/B3/pages/1', headers: reader })
    expect(epub.statusCode).toBe(404)
    expect(epub.json()).toEqual({ message: 'Book format is not supported' })

    await app.close()
  })

  it('honours zero_based, and reports out-of-range, unanalysed and unsupported books', async () => {
    const { app } = await setup()

    const zeroBased = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B1/pages/0?zero_based=true',
      headers: reader,
    })
    expect(zeroBased.statusCode).toBe(200)
    expect((await sharp(zeroBased.rawPayload).metadata()).width).toBe(800)

    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/0', headers: reader })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/99', headers: reader })).statusCode).toBe(
      400,
    )
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/NOPE/pages/1', headers: reader })).statusCode).toBe(
      404,
    )

    const unanalysed = await app.inject({ method: 'GET', url: '/api/v1/books/B4/pages/1', headers: reader })
    expect(unanalysed.statusCode).toBe(404)
    expect(unanalysed.json()).toEqual({ message: 'Book analysis failed' })

    // A book that was analysed and refused has no pages either, and the image
    // route reports it the same way as one that was never analysed.
    const unsupported = await app.inject({ method: 'GET', url: '/api/v1/books/B5/pages/1', headers: reader })
    expect(unsupported.statusCode).toBe(404)
    expect(unsupported.json()).toEqual({ message: 'Book analysis failed' })

    // A raw page is a PDF extraction this server cannot do, so the path is absent.
    const raw = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1/raw', headers: reader })
    expect(raw.statusCode).toBe(404)

    await app.close()
  })

  it('revalidates with last-modified and refuses a book the caller cannot see', async () => {
    const { app } = await setup()

    const first = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1', headers: reader })
    const lastModified = first.headers['last-modified'] as string
    expect(lastModified).toBeTruthy()
    expect(first.headers['cache-control']).toBe('max-age=0, private, must-revalidate')

    const cached = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B1/pages/1',
      headers: { ...reader, 'if-modified-since': lastModified },
    })
    expect(cached.statusCode).toBe(304)
    expect(cached.rawPayload.length).toBe(0)

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/books/B6/pages/1', headers: reader })
    expect(hidden.statusCode).toBe(403)

    await app.close()
  })
})

describe('book page thumbnails', () => {
  it('resizes the page to fit 300px and always returns a JPEG', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/1/thumbnail', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')

    const metadata = await sharp(res.rawPayload).metadata()
    expect(metadata.format).toBe('jpeg')
    // 800x1200 fits in 300x300 as 200x300.
    expect(metadata.width).toBe(200)
    expect(metadata.height).toBe(300)

    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages/99/thumbnail', headers: reader })).statusCode,
    ).toBe(400)

    await app.close()
  })
})
