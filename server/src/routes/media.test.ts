import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

/** A tiny but real PNG, so uploads exercise the same path a browser would. */
async function png(width = 4, height = 6): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer()
}

/**
 * Fixture:
 *
 * - S1 (age 12) and S2 (age 18) in L1, S3 in L2. The reader shares L1 only and
 *   has an ALLOW_ONLY 12 age restriction, so S2 and S3 are invisible to them.
 * - B1 belongs to S1 and has a real file on disk; B2 belongs to S3.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-media-root-'))
  const otherRoot = mkdtempSync(join(tmpdir(), 'ml-media-other-'))
  writeFileSync(join(root, 'v1.cbz'), 'not a real archive, only bytes')
  writeFileSync(join(root, 'absolute.cbz'), 'absolute url bytes')
  writeFileSync(join(otherRoot, 'outside.cbz'), 'outside the library root')

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-media-config-')),
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
        roles: JSON.stringify(['PAGE_STREAMING', 'FILE_DOWNLOAD']),
        shared_all_libraries: 0,
        age_restriction: 12,
        age_restriction_allow_only: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('user_api_keys')
    .values([
      { id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now },
      { id: 'K2', user_id: 'U2', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now },
    ])
    .execute()

  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Other', root: otherRoot, created_date: now, last_modified_date: now },
    ])
    .execute()
  await db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

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
        library_id: 'L1',
        name: 'Berserk',
        url: 'berserk',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S3',
        library_id: 'L2',
        name: 'Secret',
        url: 'secret',
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
        age_rating: 12,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        status: 'ONGOING',
        title: 'Berserk',
        title_sort: 'Berserk',
        age_rating: 18,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S3',
        status: 'ONGOING',
        title: 'Secret',
        title_sort: 'Secret',
        age_rating: 12,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('books')
    .values([
      {
        id: 'B1',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'v1.cbz',
        file_last_modified: now,
        file_size: 32,
        number: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B2',
        series_id: 'S3',
        library_id: 'L2',
        name: 'Volume 1',
        url: 'b1.cbz',
        file_last_modified: now,
        file_size: 32,
        number: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B3',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Missing on disk',
        url: 'gone.cbz',
        file_last_modified: now,
        file_size: 0,
        number: 2,
        created_date: now,
        last_modified_date: now,
      },
      // Komga stores absolute file URLs, and the importer copies them across.
      {
        id: 'B4',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Absolute url',
        url: pathToFileURL(join(root, 'absolute.cbz')).href,
        file_last_modified: now,
        file_size: 18,
        number: 3,
        created_date: now,
        last_modified_date: now,
      },
      // Same shape, but pointing outside the library's own root.
      {
        id: 'B5',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Outside the root',
        url: pathToFileURL(join(otherRoot, 'outside.cbz')).href,
        file_last_modified: now,
        file_size: 24,
        number: 4,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('book_metadata')
    .values([
      {
        book_id: 'B1',
        title: 'Akira Volume One',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        title: 'Secret Volume One',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        title: 'Akira Volume Two',
        number: '2',
        number_sort: 2,
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
        file_name: '001.png',
        media_type: 'image/png',
        width: 800,
        height: 1200,
        file_size: 1024,
      },
      {
        book_id: 'B1',
        number: 2,
        file_name: '002.jpg',
        media_type: 'image/jpeg',
        width: 800,
        height: 1200,
        file_size: null,
      },
      // A book whose file is gone still has pages recorded from its last analysis.
      {
        book_id: 'B3',
        number: 1,
        file_name: '001.png',
        media_type: 'image/png',
        width: 800,
        height: 1200,
        file_size: 2048,
      },
    ])
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
      thumbnail: await png(),
      created_date: '2023-01-01T00:00:00.000Z',
      last_modified_date: '2023-01-01T00:00:00.000Z',
    })
    .execute()

  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Classics', created_date: now, last_modified_date: now })
    .execute()
  await db.insertInto('collection_series').values({ collection_id: 'C1', series_id: 'S1', number: 0 }).execute()
  await db
    .insertInto('readlists')
    .values({ id: 'RL1', name: 'Favourites', created_date: now, last_modified_date: now })
    .execute()
  await db.insertInto('readlist_book').values({ readlist_id: 'RL1', book_id: 'B1', number: 0 }).execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database, root }
}

/**
 * A multipart body carrying an image.
 *
 * The bytes are concatenated as a Buffer: going through a string would re-encode
 * them and the image would no longer parse, which is not what a browser does.
 */
function multipart(image: Buffer, boundary = '----mlmedia'): { payload: Buffer; contentType: string } {
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="poster.png"\r\n' +
        'Content-Type: image/png\r\n\r\n',
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('artwork', () => {
  it('serves the selected thumbnail, and not again when the tag matches', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/thumbnail', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=86400')
    expect(res.rawPayload.length).toBeGreaterThan(0)

    const etag = res.headers.etag as string
    expect(etag).toBeTruthy()
    const cached = await app.inject({
      method: 'GET',
      url: '/api/v1/books/B1/thumbnail',
      headers: { ...admin, 'if-none-match': etag },
    })
    expect(cached.statusCode).toBe(304)
    expect(cached.rawPayload.length).toBe(0)
    await app.close()
  })

  it('gives a series the poster of one of its books', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/series/S1/thumbnail', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    // The borrowed poster is the book's own row, so it keeps the book's tag.
    expect(res.headers.etag).toBe('"T1-"')
    await app.close()
  })

  it('picks the book a series shows according to the library setting', async () => {
    const { app, database } = await setup()
    const db = database.db
    const now = new Date().toISOString()

    // B3 is the second book of S1 and the only other one with a poster, so it is
    // distinguishable from the first.
    await db
      .insertInto('thumbnails')
      .values({
        id: 'T3',
        owner_type: 'BOOK',
        owner_id: 'B3',
        type: 'GENERATED',
        page: 1,
        selected: 1,
        media_type: 'image/png',
        width: 8,
        height: 8,
        file_size: 100,
        thumbnail: await png(8, 8),
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    const withCover = async (cover: string, headers: Record<string, string>) => {
      await db.updateTable('libraries').set({ series_cover: cover }).where('id', '=', 'L1').execute()
      return app.inject({ method: 'GET', url: '/api/v1/series/S1/thumbnail', headers })
    }

    expect((await withCover('FIRST', admin)).headers.etag).toBe('"T1-"')
    expect((await withCover('FIRST_UNREAD_OR_FIRST', admin)).headers.etag).toBe('"T1-"')

    // The reader finishes the first book, so the unread one becomes the cover.
    await db
      .insertInto('read_progress')
      .values({
        book_id: 'B1',
        user_id: 'U2',
        page: 2,
        completed: 1,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    expect((await withCover('FIRST_UNREAD_OR_FIRST', reader)).headers.etag).toBe('"T3-"')

    // LAST picks the last book, which has no poster of its own: the reference
    // returns nothing rather than falling back to another book.
    expect((await withCover('LAST', admin)).statusCode).toBe(404)
    await app.close()
  })

  it('shows a collection and a read list as a mosaic of their members', async () => {
    const { app } = await setup()

    for (const url of ['/api/v1/collections/C1/thumbnail', '/api/v1/readlists/RL1/thumbnail']) {
      const res = await app.inject({ method: 'GET', url, headers: admin })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toBe('image/jpeg')
      // Built per request from what the caller can see, so it is only cached
      // privately, and only for a moment.
      expect(res.headers['cache-control'], url).toBe('private, max-age=60')

      const metadata = await sharp(res.rawPayload).metadata()
      expect(metadata.width, url).toBe(212)
      expect(metadata.height, url).toBe(300)
    }
    await app.close()
  })

  it('returns 404 when an item has no artwork at all', async () => {
    const { app, database } = await setup()
    const now = new Date().toISOString()
    // S2 has no books to borrow a poster from, and C2 holds nothing at all.
    await database.db
      .insertInto('collections')
      .values({ id: 'C2', name: 'Empty', created_date: now, last_modified_date: now })
      .execute()

    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S2/thumbnail', headers: admin })).statusCode).toBe(
      404,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/collections/C2/thumbnail', headers: admin })).statusCode,
    ).toBe(404)
    await app.close()
  })

  it('lists and fetches individual thumbnails with the documented shape', async () => {
    const { app } = await setup()

    const list = await app.inject({ method: 'GET', url: '/api/v1/books/B1/thumbnails', headers: reader })
    expect(list.statusCode).toBe(200)
    const dtos = list.json() as Record<string, unknown>[]
    expect(dtos).toHaveLength(1)
    for (const key of ['id', 'type', 'selected', 'mediaType', 'width', 'height', 'fileSize', 'bookId']) {
      expect(dtos[0], `missing ${key}`).toHaveProperty(key)
    }
    expect(dtos[0]!.bookId).toBe('B1')
    expect(dtos[0]!.type).toBe('GENERATED')
    expect(dtos[0]!.selected).toBe(true)

    const one = await app.inject({ method: 'GET', url: '/api/v1/books/B1/thumbnails/T1', headers: reader })
    expect(one.statusCode).toBe(200)
    expect(one.headers['content-type']).toBe('image/png')

    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/books/B1/thumbnails/NOPE', headers: reader })).statusCode,
    ).toBe(404)
    await app.close()
  })

  it('uses each owner type and its own id field', async () => {
    const { app, database } = await setup()

    const cases = [
      { path: '/api/v1/series/S1/thumbnails', field: 'seriesId', ownerType: 'SERIES' },
      { path: '/api/v1/collections/C1/thumbnails', field: 'collectionId', ownerType: 'COLLECTION' },
      { path: '/api/v1/readlists/RL1/thumbnails', field: 'readListId', ownerType: 'READLIST' },
    ]

    const image = await png(3, 3)
    for (const testCase of cases) {
      const body = multipart(image, `----${testCase.ownerType}`)
      const uploaded = await app.inject({
        method: 'POST',
        url: testCase.path,
        headers: { ...admin, 'content-type': body.contentType },
        payload: body.payload,
      })
      expect(uploaded.statusCode, testCase.path).toBe(200)
      const dto = uploaded.json() as Record<string, unknown>
      expect(dto[testCase.field], testCase.field).toBeTruthy()
      expect(dto.type).toBe('USER')
      expect(dto.selected).toBe(true)
      expect(dto.width).toBe(3)
      expect(dto.height).toBe(3)

      const selected = await app.inject({
        method: 'GET',
        url: testCase.path.replace('/thumbnails', '/thumbnail'),
        headers: admin,
      })
      expect(selected.statusCode, testCase.path).toBe(200)
      expect(selected.headers['content-type']).toBe('image/png')
    }

    const rows = await database.db.selectFrom('thumbnails').select(['owner_type']).where('type', '=', 'USER').execute()
    expect(rows.map((row) => row.owner_type).sort()).toEqual(['COLLECTION', 'READLIST', 'SERIES'])
    await app.close()
  })

  it('makes an uploaded poster the selected one', async () => {
    const { app, database } = await setup()

    const image = await png(8, 8)
    const body = multipart(image)
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/books/B1/thumbnails',
      headers: { ...admin, 'content-type': body.contentType },
      payload: body.payload,
    })
    expect(uploaded.statusCode).toBe(200)
    const dto = uploaded.json() as { id: string; selected: boolean; bookId: string; fileSize: number }
    expect(dto.bookId).toBe('B1')
    expect(dto.selected).toBe(true)
    expect(dto.fileSize).toBe(image.length)

    const rows = await database.db.selectFrom('thumbnails').select(['id', 'selected']).orderBy('id').execute()
    expect(rows.find((row) => row.id === 'T1')!.selected).toBe(0)
    expect(rows.find((row) => row.id === dto.id)!.selected).toBe(1)

    // Selecting the older one back is reflected in the served image.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/books/B1/thumbnails/T1/selected`,
      headers: admin,
    })
    const list = (await app.inject({ method: 'GET', url: '/api/v1/books/B1/thumbnails', headers: admin })).json() as {
      id: string
      selected: boolean
    }[]
    expect(list.find((entry) => entry.id === 'T1')!.selected).toBe(true)
    expect(list.find((entry) => entry.id === dto.id)!.selected).toBe(false)
    await app.close()
  })

  it('rejects an upload that is not an image', async () => {
    const { app } = await setup()
    const body = multipart(Buffer.from('this is not an image at all'))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/books/B1/thumbnails',
      headers: { ...admin, 'content-type': body.contentType },
      payload: body.payload,
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('deletes a thumbnail and then reports it missing', async () => {
    const { app, database } = await setup()

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/thumbnails/T1', headers: admin })).statusCode,
    ).toBe(204)
    expect(
      await database.db.selectFrom('thumbnails').select('id').where('id', '=', 'T1').executeTakeFirst(),
    ).toBeUndefined()
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/thumbnails/T1', headers: admin })).statusCode,
    ).toBe(404)
    await app.close()
  })

  it('requires admin to change artwork, and refuses owners the caller cannot see', async () => {
    const { app } = await setup()
    const body = multipart(await png())
    const image = { 'content-type': body.contentType }

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/books/B1/thumbnails',
          headers: { ...reader, ...image },
          payload: body.payload,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/thumbnails/T1', headers: reader })).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/books/B1/thumbnails/T1/selected', headers: reader })).statusCode,
    ).toBe(403)

    // S2 is age restricted for the reader, S3 lives in a library they do not share.
    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S2/thumbnails', headers: reader })).statusCode).toBe(
      403,
    )
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B2/thumbnails', headers: reader })).statusCode).toBe(
      403,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/series/NOPE/thumbnails', headers: admin })).statusCode,
    ).toBe(404)
    await app.close()
  })
})

describe('pages and files', () => {
  it('lists the pages of a book', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages' })).statusCode).toBe(401)

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages', headers: reader })
    expect(res.statusCode).toBe(200)
    const pages = res.json() as Record<string, unknown>[]
    expect(pages).toHaveLength(2)
    for (const key of ['number', 'fileName', 'mediaType', 'width', 'height', 'sizeBytes', 'size']) {
      expect(pages[0], `missing ${key}`).toHaveProperty(key)
    }
    expect(pages[0]!.number).toBe(1)
    expect(pages[0]!.fileName).toBe('001.png')
    expect(pages[0]!.sizeBytes).toBe(1024)
    expect(pages[0]!.size).toBe('1 KB')
    expect(pages[1]!.sizeBytes).toBeNull()
    await app.close()
  })

  it('requires the page streaming role for pages', async () => {
    const { app } = await setup()
    // The fixture admin only has ADMIN, which is what Komga's guard checks too.
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/pages', headers: admin })).statusCode).toBe(403)
    await app.close()
  })

  it('downloads the book file with the right type', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B1/file', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/vnd.comicbook+zip')
    expect(res.headers['content-disposition']).toContain('attachment; filename="v1.cbz"')
    expect(res.payload).toBe('not a real archive, only bytes')
    await app.close()
  })

  it('refuses a file download without the role, and when the file is gone', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B1/file', headers: admin })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B3/file', headers: reader })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B2/file', headers: reader })).statusCode).toBe(403)
    await app.close()
  })

  it('downloads a book stored as an absolute file url', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/books/B4/file', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toBe('absolute url bytes')
    expect(res.headers['content-disposition']).toContain('filename="absolute.cbz"')
    await app.close()
  })

  it('refuses a stored url that points outside the library root', async () => {
    const { app } = await setup()
    // The file exists, but it is not inside this library's root, so the row must
    // not be able to reach it.
    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B5/file', headers: reader })).statusCode).toBe(404)
    await app.close()
  })

  it('still lists pages for a book whose file is missing', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/books/B3/file', headers: reader })).statusCode).toBe(404)
    const pages = await app.inject({ method: 'GET', url: '/api/v1/books/B3/pages', headers: reader })
    expect(pages.statusCode).toBe(200)
    expect((pages.json() as unknown[]).length).toBe(1)
    await app.close()
  })

  it('queues file deletion and poster regeneration as jobs', async () => {
    const { app, database } = await setup()

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/file', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/books/B1/file', headers: admin })).statusCode).toBe(202)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/series/S1/file', headers: admin })).statusCode).toBe(202)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/series/NOPE/file', headers: admin })).statusCode).toBe(
      404,
    )
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/books/thumbnails?for_bigger_result_only=true', headers: admin }))
        .statusCode,
    ).toBe(202)

    const jobs = await database.db.selectFrom('jobs').select(['type', 'payload']).orderBy('type').execute()
    expect(jobs.map((job) => job.type)).toEqual(['DeleteBookFile', 'DeleteSeriesFile', 'RegenerateBookThumbnails'])
    expect(JSON.parse(jobs[2]!.payload as string)).toEqual({ forBiggerResultOnly: true })
    await app.close()
  })
})
