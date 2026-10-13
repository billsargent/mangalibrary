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
import type { FetchJson } from '../http.js'

const ADMIN_KEY = 'admin-key'
const READER_KEY = 'reader-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

const FEED_URL = 'https://feed.example/feed.json'
const RELEASES_URL = 'https://releases.example/releases.json'

interface Fixture {
  app: FastifyInstance
  database: Database
  calls: string[]
}

async function setup(
  urls: { feed?: string; releases?: string } = {},
  documents: Record<string, unknown> = {},
  fail = false,
): Promise<Fixture> {
  const calls: string[] = []
  const fetchJson: FetchJson = async (url) => {
    calls.push(url)
    if (fail) throw new Error('offline')
    if (!(url in documents)) throw new Error(`no document for ${url}`)
    return documents[url]
  }

  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-system-config-')),
    LOG_LEVEL: 'silent',
    ...(urls.feed === undefined ? {} : { KOMGA_ANNOUNCEMENTS_URL: urls.feed }),
    ...(urls.releases === undefined ? {} : { KOMGA_RELEASES_URL: urls.releases }),
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

  return { app: await buildServer({ config, database, fetchJson }), database, calls }
}

const FEED = {
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Announcements',
  home_page_url: 'https://example.org',
  items: [
    { id: 'a1', title: 'First', content_html: '<p>hello</p>' },
    { id: 'a2', title: 'Second' },
    // An item without an id cannot be marked read, so it is dropped rather than
    // passed through as something no client could ever track.
    { title: 'Nameless' },
  ],
}

const RELEASES = [
  {
    tag_name: 'v1.3.0-beta.1',
    published_at: '2026-02-01T00:00:00Z',
    html_url: 'https://example.org/releases/v1.3.0-beta.1',
    prerelease: true,
    body: 'beta notes',
  },
  {
    tag_name: 'v1.2.0',
    published_at: '2026-01-01T00:00:00Z',
    html_url: 'https://example.org/releases/v1.2.0',
    prerelease: false,
    body: 'stable notes',
  },
]

describe('releases', () => {
  it('maps the source into the documented shape', async () => {
    const { app, calls } = await setup({ releases: RELEASES_URL }, { [RELEASES_URL]: RELEASES })

    expect((await app.inject({ method: 'GET', url: '/api/v1/releases' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/releases', headers: reader })).statusCode).toBe(403)

    const res = await app.inject({ method: 'GET', url: '/api/v1/releases', headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        version: 'v1.3.0-beta.1',
        releaseDate: '2026-02-01T00:00:00Z',
        url: 'https://example.org/releases/v1.3.0-beta.1',
        latest: true,
        preRelease: true,
        description: 'beta notes',
      },
      {
        version: 'v1.2.0',
        releaseDate: '2026-01-01T00:00:00Z',
        url: 'https://example.org/releases/v1.2.0',
        latest: false,
        preRelease: false,
        description: 'stable notes',
      },
    ])

    // The source is asked once, however many times a client asks.
    await app.inject({ method: 'GET', url: '/api/v1/releases', headers: admin })
    expect(calls).toEqual([RELEASES_URL])

    await app.close()
  })

  it('answers nothing to show when there is no source or the source is down', async () => {
    // No source set: there are no releases to list, and that is not a failure.
    const unset = await setup()
    const none = await unset.app.inject({ method: 'GET', url: '/api/v1/releases', headers: admin })
    expect([none.statusCode, none.json()]).toEqual([200, []])
    await unset.app.close()

    const broken = await setup({ releases: RELEASES_URL }, {}, true)
    expect((await broken.app.inject({ method: 'GET', url: '/api/v1/releases', headers: admin })).statusCode).toBe(404)
    await broken.app.close()
  })
})

describe('announcements', () => {
  it('passes the feed through and adds the read flag per item', async () => {
    const { app, calls } = await setup({ feed: FEED_URL }, { [FEED_URL]: FEED })

    expect((await app.inject({ method: 'GET', url: '/api/v1/announcements' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: reader })).statusCode).toBe(403)

    const res = await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect(res.statusCode).toBe(200)
    const feed = res.json() as { title: string; home_page_url: string; items: Record<string, unknown>[] }
    expect(feed.title).toBe('Announcements')
    expect(feed.home_page_url).toBe('https://example.org')
    expect(feed.items).toEqual([
      { id: 'a1', title: 'First', content_html: '<p>hello</p>', _komga: { read: false } },
      { id: 'a2', title: 'Second', _komga: { read: false } },
    ])

    expect(calls).toEqual([FEED_URL])

    await app.close()
  })

  it('marks what a client has read, and only that', async () => {
    const { app } = await setup({ feed: FEED_URL }, { [FEED_URL]: FEED })

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/announcements',
      headers: admin,
      payload: ['a1'],
    })
    expect(put.statusCode).toBe(204)

    const afterFirst = await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect((afterFirst.json() as { items: { id: string; _komga: { read: boolean } }[] }).items).toEqual([
      { id: 'a1', title: 'First', content_html: '<p>hello</p>', _komga: { read: true } },
      { id: 'a2', title: 'Second', _komga: { read: false } },
    ])

    // The set is replaced, not added to: what the client sends is what it read.
    await app.inject({ method: 'PUT', url: '/api/v1/announcements', headers: admin, payload: ['a2'] })
    const afterSecond = await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect(
      (afterSecond.json() as { items: { id: string; _komga: { read: boolean } }[] }).items.map(
        (item) => item._komga.read,
      ),
    ).toEqual([false, true])

    // An empty list clears them all.
    await app.inject({ method: 'PUT', url: '/api/v1/announcements', headers: admin, payload: [] })
    const cleared = await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect(
      (cleared.json() as { items: { _komga: { read: boolean } }[] }).items.every((item) => !item._komga.read),
    ).toBe(true)

    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/announcements', headers: reader, payload: ['a1'] })).statusCode,
    ).toBe(403)

    await app.close()
  })

  it('answers nothing to show when there is no source or the source is down', async () => {
    const unset = await setup()
    const none = await unset.app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect(none.statusCode).toBe(200)
    expect(none.json()).toMatchObject({ title: 'Announcements', items: [] })
    await unset.app.close()

    const broken = await setup({ feed: FEED_URL }, {}, true)
    expect((await broken.app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })).statusCode).toBe(
      404,
    )
    await broken.app.close()
  })

  it('refuses a feed that is not a feed', async () => {
    const { app } = await setup({ feed: FEED_URL }, { [FEED_URL]: { nothing: 'here' } })

    // A configured URL answering something else is a configuration mistake, and
    // saying so is better than handing a foreign document to a client.
    const res = await app.inject({ method: 'GET', url: '/api/v1/announcements', headers: admin })
    expect(res.statusCode).toBe(404)

    await app.close()
  })
})

describe('metrics', () => {
  it('lists the metrics and reads one, for an administrator only', async () => {
    const { app } = await setup()

    const names = await app.inject({ method: 'GET', url: '/actuator/metrics', headers: admin })
    expect(names.statusCode).toBe(200)
    expect(names.json().names).toContain('komga.books')

    const books = await app.inject({ method: 'GET', url: '/actuator/metrics/komga.books', headers: admin })
    expect(books.statusCode).toBe(200)
    expect(books.json()).toMatchObject({
      name: 'komga.books',
      measurements: [{ statistic: 'VALUE', value: 0 }],
      availableTags: [],
    })

    for (const url of ['/actuator/metrics', '/actuator/metrics/komga.books']) {
      expect((await app.inject({ method: 'GET', url, headers: reader })).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }

    await app.close()
  })

  it('says when there is no such metric, and when a tag is not a tag', async () => {
    const { app } = await setup()
    const status = async (url: string) => (await app.inject({ method: 'GET', url, headers: admin })).statusCode

    expect(await status('/actuator/metrics/komga.nothing')).toBe(404)
    expect(await status('/actuator/metrics/komga.books?tag=library:nowhere')).toBe(404)
    expect(await status('/actuator/metrics/komga.books?tag=library')).toBe(400)
    // Several tags arrive as a repeated parameter.
    expect(await status('/actuator/metrics/komga.books?tag=library:a&tag=type:b')).toBe(404)

    await app.close()
  })
})
