import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'

interface Fixture {
  app: FastifyInstance
  database: Database
  url: string
}

async function setup(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-sse-config-')),
    LOG_LEVEL: 'silent',
    ...env,
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
    .values({
      id: 'L1',
      name: 'Main',
      root: mkdtempSync(join(tmpdir(), 'ml-sse-root-')),
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
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
  await db
    .insertInto('series_metadata')
    .values({
      series_id: 'S1',
      status: 'ONGOING',
      title: 'Akira',
      title_sort: 'Akira',
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'v1.cbz',
      file_last_modified: now,
      file_size: 10,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('book_metadata')
    .values({
      book_id: 'B1',
      title: 'Akira Volume One',
      number: '1',
      number_sort: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  // The book has been analysed: a page can only be read in a book that has pages.
  await db
    .insertInto('media')
    .values({
      book_id: 'B1',
      media_type: 'application/vnd.comicbook+zip',
      status: 'READY',
      page_count: 20,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  // The stream is a long-lived response, so the tests talk to a listening socket
  // rather than through `inject`.
  const app = await buildServer({ config, database })
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  return { app, database, url }
}

/** A client reading the event stream, with what it has seen so far. */
interface StreamClient {
  text(): string
  /** Wait until the stream contains `pattern`, or give up after `timeoutMs`. */
  waitFor(pattern: string, timeoutMs?: number): Promise<string>
  close(): Promise<void>
}

async function openStream(url: string, apiKey: string): Promise<StreamClient> {
  const controller = new AbortController()
  const response = await fetch(`${url}/sse/v1/events`, {
    headers: { 'x-api-key': apiKey },
    signal: controller.signal,
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // Aborted on close.
    }
  })()

  return {
    text: () => buffer,
    waitFor: async (pattern, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (!buffer.includes(pattern)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; saw: ${buffer}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return buffer
    },
    close: async () => {
      controller.abort()
      await pump
    },
  }
}

describe('server-sent events', () => {
  it('requires authentication', async () => {
    const { app } = await setup()

    // Inject rather than fetch: the refusal never opens the stream, so there is
    // nothing to stream and nothing to wait for.
    expect((await app.inject({ method: 'GET', url: '/sse/v1/events' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/sse/v1/events', headers: { 'x-api-key': 'nope' } })).statusCode,
    ).toBe(401)

    await app.close()
  })

  it('answers a browser with the CORS headers its origin is allowed', async () => {
    const { app, url } = await setup({ KOMGA_CORS_ALLOWED_ORIGINS: 'http://localhost:3000' })

    // The stream is written by hand, so the headers the CORS plugin added have to
    // survive onto it: without them a browser never opens the connection.
    const controller = new AbortController()
    const allowed = await fetch(`${url}/sse/v1/events`, {
      headers: { 'x-api-key': READER_KEY, origin: 'http://localhost:3000' },
      signal: controller.signal,
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))

    // An origin that was not configured still gets nothing.
    const blocked = await fetch(`${url}/sse/v1/events`, {
      headers: { 'x-api-key': READER_KEY, origin: 'http://evil.example' },
    })
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
    await blocked.body?.cancel().catch(() => {})

    await app.close()
  })

  it('carries read progress to the reader it belongs to', async () => {
    const { app, url } = await setup()
    const stream = await openStream(url, READER_KEY)
    await stream.waitFor(': connected')

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B1/read-progress',
      headers: { 'x-api-key': READER_KEY },
      payload: { page: 4 },
    })

    const seen = await stream.waitFor('event: ReadProgressChanged')
    expect(seen).toContain('"bookId":"B1"')
    expect(seen).toContain('"userId":"U2"')
    expect(seen).toContain('event: ReadProgressSeriesChanged')

    await stream.close()
    await app.close()
  })

  it('does not show one reader another reader\u2019s progress', async () => {
    const { app, url } = await setup()
    const stream = await openStream(url, READER_KEY)
    await stream.waitFor(': connected')

    // What somebody else is reading is not this reader's business.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B1/read-progress',
      headers: { 'x-api-key': ADMIN_KEY },
      payload: { page: 3 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(stream.text()).not.toContain('ReadProgressChanged')

    // Their own is delivered.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/books/B1/read-progress',
      headers: { 'x-api-key': READER_KEY },
      payload: { page: 5 },
    })
    expect(await stream.waitFor('event: ReadProgressChanged')).toContain('"userId":"U2"')

    await stream.close()
    await app.close()
  })

  it('announces a poster upload and who it belongs to', async () => {
    const { app, url } = await setup()
    const stream = await openStream(url, ADMIN_KEY)
    await stream.waitFor(': connected')

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC',
      'base64',
    )
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'poster.png')

    const upload = await fetch(`${url}/api/v1/books/B1/thumbnails`, {
      method: 'POST',
      headers: { 'x-api-key': ADMIN_KEY },
      body: form,
    })
    expect(upload.status).toBe(200)

    const seen = await stream.waitFor('event: ThumbnailBookAdded')
    expect(seen).toContain('"bookId":"B1"')
    expect(seen).toContain('"seriesId":"S1"')
    expect(seen).toContain('"selected":true')

    await stream.close()
    await app.close()
  })

  it('tells an administrator the queue depth and hides it from a reader', async () => {
    const { app, url } = await setup()

    const adminStream = await openStream(url, ADMIN_KEY)
    const readerStream = await openStream(url, READER_KEY)
    await readerStream.waitFor(': connected')

    // The depth is pushed as soon as an administrator connects.
    expect(await adminStream.waitFor('event: TaskQueueStatus')).toContain('"count":0')
    expect(readerStream.text()).not.toContain('TaskQueueStatus')

    await adminStream.close()
    await readerStream.close()
    await app.close()
  })

  it('tells a user their session ended', async () => {
    const { app, url } = await setup()
    const stream = await openStream(url, READER_KEY)
    await stream.waitFor(': connected')

    await app.inject({
      method: 'PATCH',
      url: '/api/v2/users/U2',
      headers: { 'x-api-key': ADMIN_KEY },
      payload: { roles: ['ADMIN'] },
    })

    const seen = await stream.waitFor('event: SessionExpired')
    expect(seen).toContain('"userId":"U2"')

    await stream.close()
    await app.close()
  })

  it('leaves sessions alone when an update changes nothing', async () => {
    const { app, url } = await setup()
    const stream = await openStream(url, READER_KEY)
    await stream.waitFor(': connected')

    await app.inject({
      method: 'PATCH',
      url: '/api/v2/users/U2',
      headers: { 'x-api-key': ADMIN_KEY },
      payload: { roles: ['PAGE_STREAMING'] },
    })
    await app.inject({
      method: 'PATCH',
      url: '/api/v2/users/U2',
      headers: { 'x-api-key': ADMIN_KEY },
      payload: { sharedLibraries: { all: true, libraryIds: [] } },
    })

    // Give any stray event time to arrive, then check none did.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(stream.text()).not.toContain('SessionExpired')

    await stream.close()
    await app.close()
  })
})
