import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { hashApiKey } from '../auth/users.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

// ---------------------------------------------------------------- zip fixture

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

/** One CBZ with two numbered pages, so analysis has something real to read. */
async function cbz(): Promise<Buffer> {
  return writeZip([
    { name: 'pages/2.jpg', data: await jpeg(42, 62) },
    { name: 'pages/1.jpg', data: await jpeg(40, 60) },
    { name: 'notes.txt', data: Buffer.from('not a page') },
  ])
}

// -------------------------------------------------------------------- fixture

/**
 * Fixture:
 *
 * - `scan` is a folder outside any library, holding a CBZ, a PDF, a nested CBZ,
 *   a hidden book, and files whose extension is not a book container.
 * - `libraryRoot` is a library root, with `libraryRoot/sub` to scan as a refusal.
 */
async function setup(): Promise<{
  app: FastifyInstance
  database: Database
  scan: string
  libraryRoot: string
  cbzPath: string
}> {
  const scan = mkdtempSync(join(tmpdir(), 'ml-transient-scan-'))
  writeFileSync(join(scan, 'Volume 1.cbz'), await cbz())
  writeFileSync(join(scan, 'Volume 10.cbz'), await cbz())
  writeFileSync(join(scan, 'Story.pdf'), minimalPdf())
  writeFileSync(join(scan, '.hidden.cbz'), await cbz())
  writeFileSync(join(scan, 'notes.txt'), 'not a book')
  writeFileSync(join(scan, 'cover.png'), await jpeg(4, 4))
  mkdirSync(join(scan, 'nested'))
  writeFileSync(join(scan, 'nested', 'Extra.cbz'), await cbz())
  mkdirSync(join(scan, '.hidden'))
  writeFileSync(join(scan, '.hidden', 'hidden.cbz'), await cbz())

  const libraryRoot = mkdtempSync(join(tmpdir(), 'ml-transient-library-'))
  mkdirSync(join(libraryRoot, 'sub'))

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-transient-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('users')
    .values([
      {
        id: 'U1',
        email: 'admin@example.com',
        password: hashPassword('admin-pass'),
        roles: JSON.stringify(['ADMIN']),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'U2',
        email: 'reader@example.com',
        password: hashPassword('reader-pass'),
        roles: JSON.stringify(['PAGE_STREAMING']),
        shared_all_libraries: 0,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('user_api_keys')
    .values([
      {
        id: 'K1',
        user_id: 'U1',
        key: hashApiKey(ADMIN_KEY),
        comment: 'admin',
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'K2',
        user_id: 'U2',
        key: hashApiKey(READER_KEY),
        comment: 'reader',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: libraryRoot, created_date: now, last_modified_date: now })
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database, scan, libraryRoot, cbzPath: join(scan, 'Volume 1.cbz') }
}

interface TransientBookDto {
  id: string
  name: string
  url: string
  fileLastModified: string
  sizeBytes: number
  size: string
  status: string
  mediaType: string
  pages: { number: number; fileName: string; mediaType: string; width: number | null; height: number | null }[]
  files: string[]
  comment: string
}

async function scanBooks(app: FastifyInstance, path: string): Promise<TransientBookDto[]> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/transient-books', headers: admin, payload: { path } })
  expect(res.statusCode).toBe(200)
  return res.json() as TransientBookDto[]
}

function find(books: TransientBookDto[], name: string): TransientBookDto {
  const found = books.find((book) => book.name === name)
  if (!found) throw new Error(`no transient book named ${name}`)
  return found
}

describe('scanning a folder', () => {
  it('finds every book file, ignores the rest, and sorts by path', async () => {
    const { app, scan } = await setup()

    const books = await scanBooks(app, scan)
    expect(books.map((book) => book.name).sort()).toEqual(['Extra', 'Story', 'Volume 1', 'Volume 10'])
    // Nested books are found, and the hidden file and the non-book extension are not.
    expect(books.some((book) => book.name === 'hidden')).toBe(false)
    expect(books.some((book) => book.name === 'notes')).toBe(false)
    expect(books.some((book) => book.name === 'cover')).toBe(false)

    // The list is ordered by path, which localises books beside each other.
    expect(books.map((book) => book.url)).toEqual([...books.map((book) => book.url)].sort())

    const volume = find(books, 'Volume 1')
    // A scan knows the file, but nothing about what is inside it yet.
    expect(volume.status).toBe('UNKNOWN')
    expect(volume.mediaType).toBe('')
    expect(volume.pages).toEqual([])
    expect(volume.files).toEqual([])
    expect(volume.comment).toBe('')
    expect(volume.sizeBytes).toBeGreaterThan(0)
    expect(volume.size).not.toBe('')
    expect(volume.url.endsWith('Volume 1.cbz')).toBe(true)
    expect(Number.isNaN(Date.parse(volume.fileLastModified))).toBe(false)

    await app.close()
  })

  it('refuses a folder inside a library, a folder it cannot read and an empty path', async () => {
    const { app, scan, libraryRoot } = await setup()

    const inside = await app.inject({
      method: 'POST',
      url: '/api/v1/transient-books',
      headers: admin,
      payload: { path: join(libraryRoot, 'sub') },
    })
    expect(inside.statusCode).toBe(400)
    expect(inside.json()).toEqual({ message: 'ERR_1017' })

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/transient-books',
      headers: admin,
      payload: { path: join(scan, 'nowhere') },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toEqual({ message: 'ERR_1016' })

    // A file, not a folder, is not scannable either.
    const file = await app.inject({
      method: 'POST',
      url: '/api/v1/transient-books',
      headers: admin,
      payload: { path: join(scan, 'notes.txt') },
    })
    expect(file.statusCode).toBe(400)

    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/transient-books',
      headers: admin,
      payload: { path: '' },
    })
    expect(empty.statusCode).toBe(400)

    await app.close()
  })

  it('is admin-only', async () => {
    const { app, scan } = await setup()
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/transient-books', headers: reader, payload: { path: scan } }))
        .statusCode,
    ).toBe(403)
    await app.close()
  })
})

describe('analysing a transient book', () => {
  it('reads the pages, files and media type of a CBZ', async () => {
    const { app, scan } = await setup()
    const scanned = find(await scanBooks(app, scan), 'Volume 1')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transient-books/${scanned.id}/analyze`,
      headers: admin,
    })
    expect(res.statusCode).toBe(200)
    const book = res.json() as TransientBookDto

    expect(book.status).toBe('READY')
    expect(book.mediaType).toBe('application/zip')
    expect(book.comment).toBe('')
    expect(book.pages.map((page) => page.fileName)).toEqual(['pages/1.jpg', 'pages/2.jpg'])
    expect(book.pages.map((page) => page.number)).toEqual([1, 2])
    expect(book.pages[0]?.mediaType).toBe('image/jpeg')
    // Dimensions are read for a transient book, so the preview knows the size.
    expect(book.pages[0]?.width).toBe(40)
    expect(book.pages[0]?.height).toBe(60)
    // Every entry is a file, which is what copying a book into a library needs.
    expect(book.files.sort()).toEqual(['notes.txt', 'pages/1.jpg', 'pages/2.jpg'])

    await app.close()
  })

  it('records a file it cannot read instead of throwing', async () => {
    const { app, scan } = await setup()
    // A CBZ whose bytes are not a zip: recognised by name, refused by the reader.
    writeFileSync(join(scan, 'Broken.cbz'), 'this is not a zip')
    const scanned = find(await scanBooks(app, scan), 'Broken')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transient-books/${scanned.id}/analyze`,
      headers: admin,
    })
    expect(res.statusCode).toBe(200)
    const book = res.json() as TransientBookDto
    expect(book.status).toBe('ERROR')
    expect(book.comment).toContain('ERR_1005')
    expect(book.pages).toEqual([])

    await app.close()
  })

  it('answers 404 for an id it does not know', async () => {
    const { app } = await setup()
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/transient-books/NOPE/analyze', headers: admin })).statusCode,
    ).toBe(404)
    await app.close()
  })
})

describe('reading a page', () => {
  it('serves the page bytes, and revalidates with last-modified', async () => {
    const { app, scan } = await setup()
    const scanned = find(await scanBooks(app, scan), 'Volume 1')
    await app.inject({ method: 'POST', url: `/api/v1/transient-books/${scanned.id}/analyze`, headers: admin })

    const page = await app.inject({
      method: 'GET',
      url: `/api/v1/transient-books/${scanned.id}/pages/2`,
      headers: admin,
    })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toBe('image/jpeg')
    expect(page.headers['cache-control']).toBe('max-age=0, private, must-revalidate')
    expect(page.rawPayload.length).toBeGreaterThan(0)

    const lastModified = page.headers['last-modified'] as string
    expect(lastModified).toBeTruthy()
    const cached = await app.inject({
      method: 'GET',
      url: `/api/v1/transient-books/${scanned.id}/pages/2`,
      headers: { ...admin, 'if-modified-since': lastModified },
    })
    expect(cached.statusCode).toBe(304)
    expect(cached.rawPayload.length).toBe(0)

    await app.close()
  })

  it('refuses an out-of-range page, an unanalysed book and an unknown id', async () => {
    const { app, scan } = await setup()
    const scanned = find(await scanBooks(app, scan), 'Volume 1')

    // Nothing is known about the pages until the book is analysed.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/transient-books/${scanned.id}/pages/1`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(404)

    await app.inject({ method: 'POST', url: `/api/v1/transient-books/${scanned.id}/analyze`, headers: admin })

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/transient-books/${scanned.id}/pages/0`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/transient-books/${scanned.id}/pages/99`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/transient-books/NOPE/pages/1', headers: admin })).statusCode,
    ).toBe(404)

    await app.close()
  })
})
