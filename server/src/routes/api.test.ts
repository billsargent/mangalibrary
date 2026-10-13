import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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

/** A folder that is really there, as a library's root has to be. */
const folder = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-api-library-')))

const ADMIN_KEY = 'admin-api-key'
const READER_KEY = 'reader-api-key'
const admin = { 'x-api-key': ADMIN_KEY }
const reader = { 'x-api-key': READER_KEY }

async function setup(): Promise<{ app: FastifyInstance; database: Database }> {
  const config = loadConfig({
    KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-api-')),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  await database.db
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
        age_restriction: 12,
        age_restriction_allow_only: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await database.db
    .insertInto('user_api_keys')
    .values([
      { id: 'K1', user_id: 'U1', key: ADMIN_KEY, comment: 'admin', created_date: now, last_modified_date: now },
      { id: 'K2', user_id: 'U2', key: READER_KEY, comment: 'reader', created_date: now, last_modified_date: now },
    ])
    .execute()

  await database.db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Secret', root: '/secret', created_date: now, last_modified_date: now },
    ])
    .execute()
  await database.db.insertInto('user_library_sharing').values({ user_id: 'U2', library_id: 'L1' }).execute()

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
  await database.db
    .insertInto('series_metadata')
    .values({
      series_id: 'S1',
      title: 'Akira',
      title_sort: 'Akira',
      publisher: 'Kodansha',
      language: 'en',
      age_rating: 12,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('series_metadata_author')
    .values({ series_id: 'S1', name: 'Katsuhiro Otomo', role: 'writer' })
    .execute()
  await database.db.insertInto('series_metadata_tag').values({ series_id: 'S1', tag: 'cyberpunk' }).execute()
  await database.db.insertInto('series_metadata_genre').values({ series_id: 'S1', genre: 'Science Fiction' }).execute()
  await database.db.insertInto('series_metadata_sharing').values({ series_id: 'S1', label: 'mature' }).execute()
  await database.db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'v1.cbz',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await database.db
    .insertInto('book_metadata')
    .values({ book_id: 'B1', title: 'Akira Volume One', created_date: now, last_modified_date: now })
    .execute()
  await database.db.insertInto('book_metadata_tag').values({ book_id: 'B1', tag: 'classic' }).execute()

  const app = await buildServer({ config, database })
  await app.ready()
  return { app, database }
}

describe('libraries', () => {
  it('requires authentication', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v1/libraries' })).statusCode).toBe(401)
    await app.close()
  })

  it('lists only the libraries the caller can access', async () => {
    const { app } = await setup()
    const all = await app.inject({ method: 'GET', url: '/api/v1/libraries', headers: admin })
    expect(
      all
        .json()
        .map((library: { id: string }) => library.id)
        .sort(),
    ).toEqual(['L1', 'L2'])

    const mine = await app.inject({ method: 'GET', url: '/api/v1/libraries', headers: reader })
    expect(mine.json().map((library: { id: string }) => library.id)).toEqual(['L1'])
    await app.close()
  })

  it('returns the documented LibraryDto shape', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v1/libraries/L1', headers: reader })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as Record<string, unknown>

    for (const key of [
      'id',
      'name',
      'root',
      'importComicInfoBook',
      'importComicInfoSeries',
      'importComicInfoCollection',
      'importComicInfoReadList',
      'importComicInfoSeriesAppendVolume',
      'importEpubBook',
      'importEpubSeries',
      'importMylarSeries',
      'importLocalArtwork',
      'importBarcodeIsbn',
      'scanForceModifiedTime',
      'scanOnStartup',
      'scanInterval',
      'scanCbx',
      'scanPdf',
      'scanEpub',
      'scanDirectoryExclusions',
      'repairExtensions',
      'convertToCbz',
      'emptyTrashAfterScan',
      'seriesCover',
      'hashFiles',
      'hashPages',
      'hashKoreader',
      'analyzeDimensions',
      'oneshotsDirectory',
      'unavailable',
    ]) {
      expect(dto, `missing ${key}`).toHaveProperty(key)
    }
    expect(typeof dto.importComicInfoBook).toBe('boolean')
    expect(dto.scanInterval).toBe('EVERY_6H')
    expect(dto.seriesCover).toBe('FIRST')
    expect(Array.isArray(dto.scanDirectoryExclusions)).toBe(true)
    await app.close()
  })

  it('forbids access to a library the caller cannot see', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v1/libraries/L2', headers: reader })).statusCode).toBe(403)
    await app.close()
  })

  it('creates, updates and deletes a library (admin only)', async () => {
    const { app } = await setup()

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/libraries',
          headers: reader,
          payload: { name: 'X', root: '/x' },
        })
      ).statusCode,
    ).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: admin,
      payload: { name: 'Comics', root: folder(), scanDirectoryExclusions: ['#recycle', 'lost+found'] },
    })
    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string; name: string; scanDirectoryExclusions: string[] }
    expect(dto.name).toBe('Comics')
    expect(dto.scanDirectoryExclusions).toEqual(['#recycle', 'lost+found'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${dto.id}`,
      headers: admin,
      payload: { name: 'Renamed', hashPages: true },
    })
    expect(patched.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/api/v1/libraries/${dto.id}`, headers: admin })
    expect(after.json().name).toBe('Renamed')
    expect(after.json().hashPages).toBe(true)

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/libraries/${dto.id}`, headers: admin })).statusCode,
    ).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/v1/libraries/${dto.id}`, headers: admin })).statusCode).toBe(
      404,
    )
    await app.close()
  })

  it('queues a scan as an accepted job', async () => {
    const { app, database } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/libraries/L1/scan', headers: admin })
    expect(res.statusCode).toBe(202)

    const jobs = await database.db.selectFrom('jobs').selectAll().execute()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.type).toBe('ScanLibrary')
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ libraryId: 'L1', scanDeep: false })
    await app.close()
  })

  it('scans deep when the query asks for it, which is where the contract puts it', async () => {
    const { app, database } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/v1/libraries/L1/scan?deep=true', headers: admin })
    expect(res.statusCode).toBe(202)

    const jobs = await database.db.selectFrom('jobs').selectAll().execute()
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ libraryId: 'L1', scanDeep: true })
    await app.close()
  })

  it('scans a library as soon as it is added, with nothing more to ask for', async () => {
    const { app, database } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: admin,
      payload: { name: 'Comics', root: folder() },
    })
    const { id } = created.json() as { id: string }

    const jobs = await database.db.selectFrom('jobs').selectAll().execute()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.type).toBe('ScanLibrary')
    expect(jobs[0]?.unique_key).toBe(`SCANLIBRARY_${id}`)
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ libraryId: id, scanDeep: false })
    await app.close()
  })

  it('scans a library again when it is pointed at another folder, and not when it is only renamed', async () => {
    const { app, database } = await setup()
    const jobTypes = async () => (await database.db.selectFrom('jobs').select('type').execute()).map((job) => job.type)
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/api/v1/libraries/L1', headers: admin, payload })

    expect((await patch({ name: 'Renamed' })).statusCode).toBe(204)
    expect(await jobTypes()).toEqual([])

    const { root } = await database.db
      .selectFrom('libraries')
      .select('root')
      .where('id', '=', 'L1')
      .executeTakeFirstOrThrow()
    expect((await patch({ root })).statusCode).toBe(204)
    expect(await jobTypes()).toEqual([])

    expect((await patch({ root: folder() })).statusCode).toBe(204)
    expect(await jobTypes()).toEqual(['ScanLibrary'])
    await app.close()
  })

  it('scans again when what it scans for changes, or when work on its books is switched on', async () => {
    const { app, database } = await setup()
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/api/v1/libraries/L1', headers: admin, payload })
    /** Whether the change asked for a scan, emptying the queue for the next one. */
    const scanned = async (payload: Record<string, unknown>): Promise<boolean> => {
      expect((await patch(payload)).statusCode).toBe(204)
      const jobs = await database.db.selectFrom('jobs').select('type').execute()
      await database.db.deleteFrom('jobs').execute()
      return jobs.some((job) => job.type === 'ScanLibrary')
    }
    const current = await database.db
      .selectFrom('libraries')
      .selectAll()
      .where('id', '=', 'L1')
      .executeTakeFirstOrThrow()

    // What a scan would find is different now.
    expect(await scanned({ scanPdf: current.scan_pdf !== 1 })).toBe(true)
    expect(await scanned({ scanDirectoryExclusions: ['#recycle'] })).toBe(true)
    expect(await scanned({ oneshotsDirectory: '_oneshots' })).toBe(true)
    // Said again with the same value, nothing changed.
    expect(await scanned({ oneshotsDirectory: '_oneshots' })).toBe(false)

    // Work on the books already there is queued by a scan.
    await database.db
      .updateTable('libraries')
      .set({ hash_pages: 0, convert_to_cbz: 0 })
      .where('id', '=', 'L1')
      .execute()
    expect(await scanned({ hashPages: true })).toBe(true)
    expect(await scanned({ convertToCbz: true })).toBe(true)
    // Switching it off, or changing what has nothing to do with the files, does not.
    expect(await scanned({ hashPages: false })).toBe(false)
    expect(await scanned({ seriesCover: 'LAST' })).toBe(false)
    await app.close()
  })

  it('refuses a library the reference would refuse', async () => {
    const { app, database } = await setup()
    const create = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/v1/libraries', headers: admin, payload })
    const refused = async (response: { statusCode: number; json: () => unknown }) => {
      expect(response.statusCode).toBe(400)
      return (response.json() as { message: string }).message
    }

    const outer = folder()
    const inner = join(outer, 'manga')
    mkdirSync(inner)
    const file = join(outer, 'not-a-folder.txt')
    writeFileSync(file, 'x')

    expect(await refused(await create({ name: 'Gone', root: join(outer, 'missing') }))).toContain('does not exist')
    expect(await refused(await create({ name: 'File', root: file }))).toContain('is not a folder')

    expect((await create({ name: 'Manga', root: inner })).statusCode).toBe(200)
    expect(await refused(await create({ name: 'Manga', root: folder() }))).toBe('Library name already exists')
    // The same folder, the folder around it and a folder inside it are all one library's files.
    expect(await refused(await create({ name: 'Again', root: inner }))).toContain('child of existing library Manga')
    expect(await refused(await create({ name: 'Around', root: outer }))).toContain('parent of existing library Manga')
    mkdirSync(join(inner, 'shonen'))
    expect(await refused(await create({ name: 'Inside', root: join(inner, 'shonen') }))).toContain(
      'child of existing library Manga',
    )
    // Nothing was added by a refusal, and nothing was queued for one.
    expect((await database.db.selectFrom('libraries').select('name').execute()).map((row) => row.name)).not.toContain(
      'Around',
    )

    // The same on an update - for what is being changed, and only that.
    const manga = await database.db
      .selectFrom('libraries')
      .select('id')
      .where('name', '=', 'Manga')
      .executeTakeFirstOrThrow()
    const patch = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/v1/libraries/${id}`, headers: admin, payload })
    const other = (await create({ name: 'Comics', root: folder() })).json() as { id: string }

    expect(await refused(await patch(other.id, { name: 'Manga' }))).toBe('Library name already exists')
    expect(await refused(await patch(other.id, { root: join(inner, 'shonen') }))).toContain('child of existing library')
    expect(await refused(await patch(other.id, { root: join(outer, 'missing') }))).toContain('does not exist')
    // A library is not in its own way, and one whose folder has gone can still be edited.
    expect((await patch(manga.id, { name: 'Manga', root: inner })).statusCode).toBe(204)
    await database.db
      .updateTable('libraries')
      .set({ root: join(outer, 'missing') })
      .where('id', '=', other.id)
      .execute()
    expect((await patch(other.id, { hashFiles: false })).statusCode).toBe(204)
    await app.close()
  })
})

describe('referentials', () => {
  it('returns distinct values for the visible content', async () => {
    const { app } = await setup()
    const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: admin })).json()

    expect(await get('/api/v1/genres')).toEqual(['Science Fiction'])
    expect(await get('/api/v1/tags')).toEqual(['cyberpunk'])
    expect(await get('/api/v1/tags/book')).toEqual(['classic'])
    expect(await get('/api/v1/publishers')).toEqual(['Kodansha'])
    expect(await get('/api/v1/languages')).toEqual(['en'])
    expect(await get('/api/v1/sharing-labels')).toEqual(['mature'])
    expect(await get('/api/v1/age-ratings')).toEqual(['12'])
    expect(await get('/api/v1/authors')).toEqual([{ name: 'Katsuhiro Otomo', role: 'writer' }])
    expect(await get('/api/v1/authors/names')).toEqual(['Katsuhiro Otomo'])
    expect(await get('/api/v1/authors/roles')).toEqual(['writer'])
    await app.close()
  })

  it('wraps v2 referentials in a Spring page', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v2/genres', headers: admin })
    const page = res.json() as {
      content: string[]
      totalElements: number
      size: number
      number: number
      pageable: unknown
    }
    expect(page.content).toEqual(['Science Fiction'])
    expect(page.totalElements).toBe(1)
    expect(page.size).toBe(20)
    expect(page.number).toBe(0)
    expect(page).toHaveProperty('pageable')
    await app.close()
  })

  it('is empty for a user with no accessible libraries', async () => {
    const { app, database } = await setup()
    await database.db.deleteFrom('user_library_sharing').where('user_id', '=', 'U2').execute()
    const res = await app.inject({ method: 'GET', url: '/api/v1/genres', headers: reader })
    expect(res.json()).toEqual([])
    await app.close()
  })
})

describe('users', () => {
  it('returns the authenticated user from /me', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/v2/users/me', headers: reader })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as Record<string, unknown>
    expect(dto.id).toBe('U2')
    expect(dto.email).toBe('reader@example.com')
    // Every user is reported with USER: it is the role that stands for "may use the
    // server at all", and the reference adds it to every user's DTO.
    expect(dto.roles).toEqual(['PAGE_STREAMING', 'USER'])
    expect(dto.sharedAllLibraries).toBe(false)
    expect(dto.sharedLibrariesIds).toEqual(['L1'])
    expect(dto.ageRestriction).toEqual({ age: 12, restriction: 'ALLOW_ONLY' })
    expect(dto.labelsAllow).toEqual([])
    await app.close()
  })

  it('creates, updates and deletes a user (admin only)', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/v2/users', headers: reader })).statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: {
        email: 'new@example.com',
        password: 'secret',
        roles: ['FILE_DOWNLOAD'],
        sharedLibraries: { all: false, libraryIds: ['L1'] },
        labelsAllow: ['kids'],
        labelsExclude: ['mature'],
        ageRestriction: { age: 10, restriction: 'ALLOW_ONLY' },
      },
    })
    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string }
    expect(dto.id).toBeTruthy()

    const fetched = await app.inject({ method: 'GET', url: `/api/v2/users/${dto.id}`, headers: admin })
    expect(fetched.json().sharedLibrariesIds).toEqual(['L1'])
    expect(fetched.json().labelsAllow).toEqual(['kids'])
    expect(fetched.json().labelsExclude).toEqual(['mature'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/users/${dto.id}`,
      headers: admin,
      payload: { roles: ['ADMIN'], ageRestriction: { age: 0, restriction: 'NONE' } },
    })
    expect(patched.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/api/v2/users/${dto.id}`, headers: admin })
    expect(after.json().roles).toEqual(['ADMIN', 'USER'])
    expect(after.json().ageRestriction).toBeUndefined()

    expect((await app.inject({ method: 'DELETE', url: `/api/v2/users/${dto.id}`, headers: admin })).statusCode).toBe(
      204,
    )
    await app.close()
  })

  it('manages API keys for the current user', async () => {
    const { app } = await setup()
    const list = await app.inject({ method: 'GET', url: '/api/v2/users/me/api-keys', headers: admin })
    expect(list.json()).toHaveLength(1)

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/users/me/api-keys',
      headers: admin,
      payload: { comment: 'test key' },
    })
    expect(created.statusCode).toBe(200)
    const key = created.json() as { id: string; key: string; comment: string; userId: string }
    expect(key.comment).toBe('test key')
    expect(key.userId).toBe('U1')
    expect(key.key.length).toBeGreaterThan(10)

    // A comment names one key of a user's. Another user may use the same one.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v2/users/me/api-keys',
      headers: admin,
      payload: { comment: '  test key ' },
    })
    expect(again.statusCode).toBe(400)
    expect(again.json()).toMatchObject({ message: 'ERR_1034' })
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/users/me/api-keys',
          headers: reader,
          payload: { comment: 'test key' },
        })
      ).statusCode,
    ).toBe(200)

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v2/users/me/api-keys/${key.id}`, headers: admin })).statusCode,
    ).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v2/users/me/api-keys', headers: admin })).json()).toHaveLength(
      1,
    )
    await app.close()
  })

  it('records and returns authentication activity', async () => {
    const { app } = await setup()
    await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'admin@example.com', password: 'wrong' },
    })

    const mine = await app.inject({ method: 'GET', url: '/api/v2/users/me/authentication-activity', headers: admin })
    const page = mine.json() as { content: { success: boolean }[]; totalElements: number }
    expect(page.totalElements).toBe(1)
    expect(page.content[0]?.success).toBe(false)

    const all = await app.inject({ method: 'GET', url: '/api/v2/users/authentication-activity', headers: admin })
    expect((all.json() as { totalElements: number }).totalElements).toBe(1)
    await app.close()
  })

  it('refuses to change or delete the caller\u2019s own account through the admin routes', async () => {
    const { app } = await setup()

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v2/users/U1',
      headers: admin,
      payload: { roles: ['PAGE_STREAMING'] },
    })
    expect(patched.statusCode).toBe(403)

    expect((await app.inject({ method: 'DELETE', url: '/api/v2/users/U1', headers: admin })).statusCode).toBe(403)

    // The account is untouched, and still an administrator.
    const me = await app.inject({ method: 'GET', url: '/api/v2/users/me', headers: admin })
    expect((me.json() as { roles: string[] }).roles).toEqual(['ADMIN', 'USER'])

    await app.close()
  })

  it('requires a role array when creating a user', async () => {
    const { app, database } = await setup()

    const asString = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'a@example.com', password: 'secret', roles: 'FILE_DOWNLOAD' },
    })
    expect(asString.statusCode).toBe(400)

    const absent = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'a@example.com', password: 'secret' },
    })
    expect(absent.statusCode).toBe(400)

    // No account was created by either refusal.
    const users = await app.inject({ method: 'GET', url: '/api/v2/users', headers: admin })
    expect((users.json() as { email: string }[]).map((user) => user.email)).not.toContain('a@example.com')

    // An unknown role name is refused, naming the value: an account that quietly lost
    // the permission it asked for is worse than a refusal.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'b@example.com', password: 'secret', roles: ['FILE_DOWNLOAD', 'NOT_A_ROLE'] },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toEqual({ message: 'unknown role: NOT_A_ROLE' })

    // An empty list is allowed, as the reference allows it: the account can sign in
    // and read its own profile, and nothing else. It is still reported as a USER.
    const none = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'c@example.com', password: 'secret', roles: [] },
    })
    expect(none.statusCode).toBe(200)
    expect((none.json() as { roles: string[] }).roles).toEqual(['USER'])

    // Roles are de-duplicated, so a repeated name is one role.
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'd@example.com', password: 'secret', roles: ['FILE_DOWNLOAD', 'FILE_DOWNLOAD'] },
    })
    expect((repeated.json() as { roles: string[] }).roles).toEqual(['FILE_DOWNLOAD', 'USER'])

    // USER is accepted and dropped rather than refused: a client that reads a user and
    // writes it back sends the role the server told it about, and a 400 for echoing
    // back what was read is a client that cannot edit anybody.
    const echoed = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'e@example.com', password: 'secret', roles: ['USER', 'PAGE_STREAMING'] },
    })
    expect(echoed.statusCode).toBe(200)
    expect((echoed.json() as { roles: string[] }).roles).toEqual(['PAGE_STREAMING', 'USER'])
    const stored = await database.db
      .selectFrom('users')
      .select('roles')
      .where('id', '=', (echoed.json() as { id: string }).id)
      .executeTakeFirstOrThrow()
    // It is not a storable role: reporting it does not put it in the database.
    expect(JSON.parse(stored.roles)).toEqual(['PAGE_STREAMING'])

    // The same rule applies to an update, whichever way the value is wrong.
    const id = (none.json() as { id: string }).id
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/v2/users/${id}`, headers: admin, payload: { roles: 'ADMIN' } }))
        .statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v2/users/${id}`,
          headers: admin,
          payload: { roles: ['PAGE_STREAMING', 'NOT_A_ROLE'] },
        })
      ).json(),
    ).toEqual({ message: 'unknown role: NOT_A_ROLE' })

    await app.close()
  })

  it('lets one of two administrators be demoted', async () => {
    const { app, database } = await setup()

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'second@example.com', password: 'secret', roles: ['ADMIN'] },
    })
    const second = (created.json() as { id: string }).id

    // There are two administrators now, so one of them may stop being one.
    const demoted = await app.inject({
      method: 'PATCH',
      url: `/api/v2/users/${second}`,
      headers: admin,
      payload: { roles: ['PAGE_STREAMING'] },
    })
    expect(demoted.statusCode).toBe(204)

    const stored = await database.db
      .selectFrom('users')
      .select('roles')
      .where('id', '=', second)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(stored.roles)).toEqual(['PAGE_STREAMING'])
    await app.close()
  })

  it('gives a new user every library unless the request says otherwise', async () => {
    const { app } = await setup()

    // The field was added after the endpoint existed, so a request that says
    // nothing about libraries means all of them.
    const open = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: { email: 'open@example.com', password: 'secret', roles: ['PAGE_STREAMING'] },
    })
    expect((open.json() as { sharedAllLibraries: boolean }).sharedAllLibraries).toBe(true)

    // A named library that does not exist is not shared, rather than stored as a
    // share nobody can see.
    const named = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      headers: admin,
      payload: {
        email: 'named@example.com',
        password: 'secret',
        roles: ['PAGE_STREAMING'],
        sharedLibraries: { all: false, libraryIds: ['L1', 'NOPE'] },
      },
    })
    const dto = named.json() as { sharedAllLibraries: boolean; sharedLibrariesIds: string[] }
    expect(dto.sharedAllLibraries).toBe(false)
    expect(dto.sharedLibrariesIds).toEqual(['L1'])

    await app.close()
  })
})
