import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import yauzl from 'yauzl'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { extendedFileName } from '../testing/headers.js'
import { hashApiKey } from '../auth/users.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const LIMITED_KEY = 'limited-key'
const reader = { 'x-api-key': READER_KEY }
const limited = { 'x-api-key': LIMITED_KEY }

/** Read a ZIP back with an independent reader. */
function readZip(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('not a zip'))
        return
      }

      const entries: { name: string; data: Buffer }[] = []
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('cannot read entry'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) })
            zipfile.readEntry()
          })
          stream.on('error', reject)
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

/**
 * Fixture:
 *
 * - S1 (Akira) in L1 with three books: B1 and B2 have files, B3's is gone.
 * - RL1 holds B2 then B1, in that order.
 * - S2 is in L2, which the reader cannot see.
 */
async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-archives-root-'))
  const otherRoot = mkdtempSync(join(tmpdir(), 'ml-archives-other-'))
  writeFileSync(join(root, 'a.cbz'), 'AAA')
  writeFileSync(join(root, 'b.cbz'), 'BBBB')

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-archives-config-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  const user = (id: string, roles: string[]) => ({
    id,
    email: `${id}@example.com`,
    password: hashPassword('pass'),
    roles: JSON.stringify(roles),
    shared_all_libraries: 0,
    age_restriction: null,
    age_restriction_allow_only: null,
    created_date: now,
    last_modified_date: now,
  })
  await db
    .insertInto('users')
    .values([user('U1', ['ADMIN']), user('U2', ['PAGE_STREAMING', 'FILE_DOWNLOAD']), user('U3', ['PAGE_STREAMING'])])
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
      {
        id: 'K3',
        user_id: 'U3',
        key: hashApiKey(LIMITED_KEY),
        comment: 'limited',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Other', root: otherRoot, created_date: now, last_modified_date: now },
    ])
    .execute()
  await db
    .insertInto('user_library_sharing')
    .values([
      { user_id: 'U2', library_id: 'L1' },
      { user_id: 'U3', library_id: 'L1' },
    ])
    .execute()

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
        language: '',
        reading_direction: null,
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

  const book = (id: string, seriesId: string, url: string, number: number) => ({
    id,
    series_id: seriesId,
    library_id: seriesId === 'S2' ? 'L2' : 'L1',
    name: `Volume ${number}`,
    url,
    file_last_modified: now,
    file_size: 3,
    number,
    created_date: now,
    last_modified_date: now,
  })
  await db
    .insertInto('books')
    .values([
      book('B1', 'S1', 'a.cbz', 1),
      book('B2', 'S1', 'b.cbz', 2),
      book('B3', 'S1', 'gone.cbz', 3),
      book('B4', 'S2', 'hidden.cbz', 1),
    ])
    .execute()

  await db
    .insertInto('readlists')
    .values({ id: 'RL1', name: 'Favourites', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('readlist_book')
    .values([
      { readlist_id: 'RL1', book_id: 'B2', number: 0 },
      { readlist_id: 'RL1', book_id: 'B1', number: 1 },
    ])
    .execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('series archive', () => {
  it('is a ZIP of the series book files, named after them', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/series/S1/file', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('Akira.zip')

    const entries = await readZip(res.rawPayload)
    // B3's file is gone, so it is skipped rather than failing the download.
    expect(entries.map((entry) => entry.name)).toEqual(['a.cbz', 'b.cbz'])
    expect(entries[0]?.data.toString()).toBe('AAA')
    expect(entries[1]?.data.toString()).toBe('BBBB')

    await app.close()
  })

  it('requires the download role, and a series the caller may see', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S1/file', headers: limited })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/series/S2/file', headers: reader })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/series/NOPE/file', headers: reader })).statusCode).toBe(404)

    await app.close()
  })
})

describe('read list archive', () => {
  it('numbers its entries in read list order', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/file', headers: reader })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('Favourites.zip')

    const entries = await readZip(res.rawPayload)
    expect(entries.map((entry) => entry.name)).toEqual(['1 - b.cbz', '2 - a.cbz'])
    expect(entries[0]?.data.toString()).toBe('BBBB')

    await app.close()
  })

  it('requires the download role, and a read list the caller may see', async () => {
    const { app } = await setup()

    expect((await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/file', headers: limited })).statusCode).toBe(
      403,
    )
    expect((await app.inject({ method: 'GET', url: '/api/v1/readlists/NOPE/file', headers: reader })).statusCode).toBe(
      404,
    )

    await app.close()
  })
})

describe('book file download', () => {
  it('answers on a file name appended to the path as well', async () => {
    const { app } = await setup()

    const plain = await app.inject({ method: 'GET', url: '/api/v1/books/B1/file', headers: reader })
    expect(plain.statusCode).toBe(200)
    expect(plain.payload).toBe('AAA')

    const named = await app.inject({ method: 'GET', url: '/api/v1/books/B1/file/a.cbz', headers: reader })
    expect(named.statusCode).toBe(200)
    expect(named.payload).toBe('AAA')

    await app.close()
  })
})

describe('a series or a read list whose name a header cannot carry as it is', () => {
  it('still downloads, under its own name', async () => {
    const { app, database } = await setup()
    await database.db
      .updateTable('series_metadata')
      .set({ title: '進撃の巨人' })
      .where('series_id', '=', 'S1')
      .execute()
    await database.db.updateTable('readlists').set({ name: 'お気に入り "2024"' }).where('id', '=', 'RL1').execute()

    const series = await app.inject({ method: 'GET', url: '/api/v1/series/S1/file', headers: reader })
    expect(series.statusCode).toBe(200)
    expect(extendedFileName(series.headers['content-disposition'])).toBe('進撃の巨人.zip')
    expect((await readZip(series.rawPayload)).map((entry) => entry.name)).toEqual(['a.cbz', 'b.cbz'])

    const readList = await app.inject({ method: 'GET', url: '/api/v1/readlists/RL1/file', headers: reader })
    expect(readList.statusCode).toBe(200)
    expect(extendedFileName(readList.headers['content-disposition'])).toBe('お気に入り "2024".zip')

    await app.close()
  })
})
