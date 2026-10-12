import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import type { DB } from '../db/schema.js'
import { analyzeBook } from '../media/analyze.js'
import { writeZip } from '../testing/zip.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

interface Fixture {
  app: FastifyInstance
  database: Database
  db: Kysely<DB>
}

/** A page image, distinct per seed. */
async function page(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 180, channels: 3, background: { r: seed, g: seed, b: seed } } })
    .png()
    .toBuffer()
}

/**
 * A server with two analysed books, and the hashes given to some of their pages.
 *
 * The books are real files, because a page hash that matches a page nobody can
 * read is not a duplicate worth listing - the thumbnail routes open the book.
 */
async function setup(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'ml-page-hashes-'))
  writeFileSync(
    join(root, 'v1.cbz'),
    writeZip([
      { name: '1.png', data: await page(10) },
      { name: '2.png', data: await page(20) },
    ]),
  )
  writeFileSync(
    join(root, 'v2.cbz'),
    writeZip([
      { name: '1.png', data: await page(30) },
      { name: '2.png', data: await page(40) },
    ]),
  )

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-page-hashes-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db
  const now = new Date().toISOString()

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
        shared_all_libraries: 1,
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
      { id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now },
      { id: 'K2', user_id: 'U2', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now },
    ])
    .execute()

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now })
    .execute()

  for (const [index, name] of ['v1.cbz', 'v2.cbz'].entries()) {
    const number = index + 1
    await db
      .insertInto('series')
      .values({
        id: `S${number}`,
        library_id: 'L1',
        name: `Series ${number}`,
        url: `series-${number}`,
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await db
      .insertInto('books')
      .values({
        id: `B${number}`,
        series_id: `S${number}`,
        library_id: 'L1',
        name: `Volume ${number}`,
        url: name,
        file_last_modified: now,
        number,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    await analyzeBook(db, `B${number}`, join(root, name))
  }

  // The same page in both books is a duplicate nobody has judged yet; the second
  // page of the first book is a duplicate somebody has.
  await db
    .updateTable('media_page')
    .set({ file_hash: 'dup-1' })
    .where('book_id', '=', 'B1')
    .where('number', '=', 1)
    .execute()
  await db
    .updateTable('media_page')
    .set({ file_hash: 'dup-1' })
    .where('book_id', '=', 'B2')
    .where('number', '=', 1)
    .execute()
  await db
    .updateTable('media_page')
    .set({ file_hash: 'known-1' })
    .where('book_id', '=', 'B1')
    .where('number', '=', 2)
    .execute()
  await db
    .updateTable('media_page')
    .set({ file_hash: 'known-1' })
    .where('book_id', '=', 'B2')
    .where('number', '=', 2)
    .execute()

  await db
    .insertInto('page_hash')
    .values({
      hash: 'known-1',
      size: 4096,
      action: 'IGNORE',
      delete_count: 2,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('page_hash_thumbnail')
    .values({ hash: 'known-1', thumbnail: await page(99) })
    .execute()

  return { app: await buildServer({ config, database }), database, db }
}

describe('listing known duplicates', () => {
  it('counts the pages that carry each hash', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes', headers: admin })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.content).toHaveLength(1)
    expect(body.content[0]).toEqual({
      hash: 'known-1',
      size: 4096,
      action: 'IGNORE',
      deleteCount: 2,
      matchCount: 2,
      created: body.content[0].created,
      lastModified: body.content[0].lastModified,
    })
    expect(body.totalElements).toBe(1)
    expect(body.number).toBe(0)

    await database.close()
  })

  it('lists only the actions asked for, and refuses an action that is not one', async () => {
    const { app, database } = await setup()
    await database.db
      .insertInto('page_hash')
      .values({
        hash: 'dup-1',
        size: null,
        action: 'DELETE_MANUAL',
        created_date: new Date().toISOString(),
        last_modified_date: new Date().toISOString(),
      })
      .execute()

    const ignored = await app.inject({ method: 'GET', url: '/api/v1/page-hashes?action=IGNORE', headers: admin })
    expect(ignored.json().content.map((entry: { hash: string }) => entry.hash)).toEqual(['known-1'])

    const both = await app.inject({
      method: 'GET',
      url: '/api/v1/page-hashes?action=IGNORE&action=DELETE_MANUAL',
      headers: admin,
    })
    expect(
      both
        .json()
        .content.map((entry: { hash: string }) => entry.hash)
        .sort(),
    ).toEqual(['dup-1', 'known-1'])
    expect(both.json().totalElements).toBe(2)

    const bad = await app.inject({ method: 'GET', url: '/api/v1/page-hashes?action=MOSTLY', headers: admin })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().message).toContain('action must be one of')

    await database.close()
  })

  it('pages through them', async () => {
    const { app, database } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('page_hash')
      .values({
        hash: 'dup-1',
        size: null,
        action: 'DELETE_MANUAL',
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    const first = await app.inject({ method: 'GET', url: '/api/v1/page-hashes?size=1', headers: admin })
    expect(first.json().content).toHaveLength(1)
    expect(first.json().totalElements).toBe(2)
    expect(first.json().totalPages).toBe(2)
    expect(first.json().first).toBe(true)

    const second = await app.inject({ method: 'GET', url: '/api/v1/page-hashes?size=1&page=1', headers: admin })
    expect(second.json().content).toHaveLength(1)
    expect(second.json().last).toBe(true)

    await database.close()
  })

  it('sorts by the count asked for', async () => {
    const { app, database } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('page_hash')
      .values({ hash: 'dup-1', size: null, action: 'IGNORE', created_date: now, last_modified_date: now })
      .execute()

    // Both hashes match two pages, so the delete count decides.
    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes?sort=deleteCount,desc', headers: admin })
    expect(res.json().content.map((entry: { hash: string }) => entry.hash)).toEqual(['known-1', 'dup-1'])

    await database.close()
  })

  it('is administrative only', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes', headers: reader })
    expect(res.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/page-hashes' })).statusCode).toBe(401)

    await database.close()
  })
})

describe('listing unknown duplicates', () => {
  it('lists a hash nobody judged, carried by more than one page', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/unknown', headers: admin })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.content).toEqual([{ hash: 'dup-1', size: expect.any(Number), matchCount: 2 }])
    expect(body.totalElements).toBe(1)

    await database.close()
  })

  it('leaves out a hash somebody has judged', async () => {
    const { app, database } = await setup()

    await database.db.updateTable('media_page').set({ file_hash: 'known-1' }).where('file_hash', '=', 'dup-1').execute()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/unknown', headers: admin })
    expect(res.json().content).toEqual([])

    await database.close()
  })
})

describe('the matches of a hash', () => {
  it('names the book, the page and the file of each', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/dup-1', headers: admin })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.content).toHaveLength(2)
    expect(body.content[0]).toEqual({
      bookId: 'B1',
      url: 'v1.cbz',
      pageNumber: 1,
      fileName: '1.png',
      fileSize: expect.any(Number),
      mediaType: 'image/png',
    })
    expect(body.content[1].bookId).toBe('B2')

    await database.close()
  })

  it('is empty for a hash nothing carries', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/nothing', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toEqual([])
    expect(res.json().totalElements).toBe(0)

    await database.close()
  })
})

describe('the thumbnail of a hash', () => {
  it('is the picture stored with a known hash, and a 404 when there is none', async () => {
    const { app, database } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/known-1/thumbnail', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect((await sharp(res.rawPayload).metadata()).width).toBe(120)

    const missing = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/dup-1/thumbnail', headers: admin })
    expect(missing.statusCode).toBe(404)

    await database.close()
  })

  it('is the page itself for an unknown hash, resized when asked', async () => {
    const { app, database } = await setup()

    const page = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/unknown/dup-1/thumbnail', headers: admin })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toBe('image/png')

    const resized = await app.inject({
      method: 'GET',
      url: '/api/v1/page-hashes/unknown/dup-1/thumbnail?resize=60',
      headers: admin,
    })
    expect(resized.statusCode).toBe(200)
    expect(resized.headers['content-type']).toBe('image/jpeg')
    const metadata = await sharp(resized.rawPayload).metadata()
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(60)

    const nothing = await app.inject({
      method: 'GET',
      url: '/api/v1/page-hashes/unknown/nothing/thumbnail',
      headers: admin,
    })
    expect(nothing.statusCode).toBe(404)

    await database.close()
  })
})

describe('judging a hash', () => {
  it('marks an unknown hash as known, with a picture of one of its pages', async () => {
    const { app, database } = await setup()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: admin,
      payload: { hash: 'dup-1', size: 1234, action: 'DELETE_AUTO' },
    })
    expect(res.statusCode).toBe(202)

    const row = await database.db
      .selectFrom('page_hash')
      .selectAll()
      .where('hash', '=', 'dup-1')
      .executeTakeFirstOrThrow()
    expect(row.action).toBe('DELETE_AUTO')
    expect(row.size).toBe(1234)
    expect(row.delete_count).toBe(0)

    // The page is smaller than the size a known thumbnail is made at, so it is
    // re-encoded at its own size rather than enlarged - which makes it a JPEG, as
    // the reference converts it.
    const thumbnail = await database.db
      .selectFrom('page_hash_thumbnail')
      .select('thumbnail')
      .where('hash', '=', 'dup-1')
      .executeTakeFirstOrThrow()
    const metadata = await sharp(thumbnail.thumbnail!).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(120)
    expect(metadata.height).toBe(180)

    // And it is no longer unknown.
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/page-hashes/unknown', headers: admin })
    expect(unknown.json().content).toEqual([])

    await database.close()
  })

  it('changes the action of a hash already judged, without losing its count', async () => {
    const { app, database } = await setup()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: admin,
      payload: { hash: 'known-1', action: 'DELETE_MANUAL' },
    })
    expect(res.statusCode).toBe(202)

    const row = await database.db
      .selectFrom('page_hash')
      .selectAll()
      .where('hash', '=', 'known-1')
      .executeTakeFirstOrThrow()
    expect(row.action).toBe('DELETE_MANUAL')
    expect(row.delete_count).toBe(2)
    expect(row.size).toBeNull()

    await database.close()
  })

  it('refuses a blank hash, an action that is not one, and a size that is not a number', async () => {
    const { app, database } = await setup()

    const blank = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: admin,
      payload: { hash: '  ', action: 'IGNORE' },
    })
    expect(blank.statusCode).toBe(400)

    const action = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: admin,
      payload: { hash: 'dup-1', action: 'MAYBE' },
    })
    expect(action.statusCode).toBe(400)
    expect(action.json().message).toContain('action must be one of')

    const size = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: admin,
      payload: { hash: 'dup-1', action: 'IGNORE', size: 'big' },
    })
    expect(size.statusCode).toBe(400)

    expect(await database.db.selectFrom('page_hash').selectAll().execute()).toHaveLength(1)

    await database.close()
  })

  it('is administrative only', async () => {
    const { app, database } = await setup()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/page-hashes',
      headers: reader,
      payload: { hash: 'dup-1', action: 'IGNORE' },
    })
    expect(res.statusCode).toBe(403)

    await database.close()
  })
})
