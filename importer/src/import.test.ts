import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../../server/src/db/index.js'
import { importKomga } from './import.js'
import { createLegacyFixture } from './testing/legacy-fixture.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-import-'))
  const from = join(dir, 'legacy')
  mkdirSync(from, { recursive: true })
  createLegacyFixture(join(from, 'database.sqlite'))
  return { from, to: join(dir, 'target') }
}

describe('komga-import', () => {
  it('imports identity, content, progress and artwork', async () => {
    const { from, to } = setup()
    const report = await importKomga({ from, to })
    expect(report.totalRows).toBeGreaterThan(0)
    expect(report.migrations.length).toBeGreaterThan(0)

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      const libraries = await database.db.selectFrom('libraries').selectAll().execute()
      expect(libraries.map((library) => library.name)).toEqual(['Library'])

      const exclusions = await database.db.selectFrom('library_exclusions').selectAll().execute()
      expect(exclusions.map((row) => row.exclusion)).toEqual(['#recycle'])

      const users = await database.db.selectFrom('users').selectAll().orderBy('email').execute()
      expect(users.map((user) => user.email)).toEqual(['admin@example.com', 'kid@example.com'])
      expect(JSON.parse(users[0]!.roles)).toEqual(['ADMIN', 'FILE_DOWNLOAD'])
      expect(users[1]!.age_restriction).toBe(12)
      expect(users[1]!.age_restriction_allow_only).toBe(1)
      expect(users[1]!.shared_all_libraries).toBe(0)

      const labelSharing = await database.db.selectFrom('user_sharing').selectAll().orderBy('allow').execute()
      expect(labelSharing).toEqual([
        { user_id: 'U2', allow: 0, label: 'mature' },
        { user_id: 'U2', allow: 1, label: 'kids' },
      ])

      const sharing = await database.db.selectFrom('user_library_sharing').selectAll().execute()
      expect(sharing).toEqual([{ user_id: 'U2', library_id: 'L1' }])

      const series = await database.db.selectFrom('series').selectAll().execute()
      expect(series.map((row) => row.name)).toEqual(['Akira'])

      const seriesMetadata = await database.db.selectFrom('series_metadata').selectAll().execute()
      expect(seriesMetadata[0]?.status).toBe('ENDED')
      expect(seriesMetadata[0]?.title_lock).toBe(1)
      expect(seriesMetadata[0]?.publisher).toBe('Kodansha')

      expect((await database.db.selectFrom('series_metadata_author').selectAll().execute()).length).toBe(1)
      expect((await database.db.selectFrom('series_metadata_sharing').selectAll().execute()).length).toBe(1)

      const books = await database.db.selectFrom('books').selectAll().orderBy('number').execute()
      expect(books.map((book) => book.name)).toEqual(['Volume 1', 'Volume 2'])
      expect(books[0]?.file_size).toBe(1024)

      const bookMetadata = await database.db.selectFrom('book_metadata').selectAll().orderBy('book_id').execute()
      expect(bookMetadata[0]?.title).toBe('Akira Volume One')
      expect(bookMetadata[0]?.number_sort).toBe(1)

      expect((await database.db.selectFrom('media').selectAll().execute()).length).toBe(2)
      const pages = await database.db.selectFrom('media_page').selectAll().execute()
      expect(pages[0]?.width).toBe(800)

      const thumbnails = await database.db.selectFrom('thumbnails').selectAll().orderBy('owner_type').execute()
      expect(thumbnails.map((row) => row.owner_type)).toEqual(['BOOK', 'SERIES'])
      expect(thumbnails[0]?.thumbnail.length).toBe(4)

      const progress = await database.db.selectFrom('read_progress').selectAll().execute()
      expect(progress[0]?.page).toBe(42)
      expect(progress[0]?.read_date).toBe('2024-02-01T12:00:00Z')

      const collections = await database.db.selectFrom('collections').selectAll().execute()
      expect(collections[0]?.name).toBe('Favourites')
      expect(collections[0]?.series_count).toBe(1)

      const readLists = await database.db.selectFrom('readlists').selectAll().execute()
      expect(readLists[0]?.book_count).toBe(1)

      const settings = await database.db.selectFrom('server_settings').selectAll().orderBy('key').execute()
      expect(settings.map((row) => row.key)).toContain('REMEMBER_ME_KEY')

      const clientSettings = await database.db.selectFrom('client_settings_user').selectAll().execute()
      expect(clientSettings).toEqual([{ user_id: 'U1', key: 'WEBUI_POSTER_STRETCH', value: 'true' }])

      expect((await database.db.selectFrom('page_hash').selectAll().execute()).length).toBe(1)
      expect((await database.db.selectFrom('page_hash_unknown').selectAll().execute()).length).toBe(1)
    } finally {
      await database.close()
    }
  })

  it('makes imported content searchable through FTS5', async () => {
    const { from, to } = setup()
    await importKomga({ from, to })

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      const result = await sql<{ book_id: string }>`
        select book_id from fts_books where fts_books match ${'akira'}
      `.execute(database.db)
      expect(result.rows.map((row) => row.book_id).sort()).toEqual(['B1', 'B2'])
    } finally {
      await database.close()
    }
  })

  it('writes nothing on a dry run', async () => {
    const { from, to } = setup()
    const report = await importKomga({ from, to, dryRun: true })
    expect(report.totalRows).toBeGreaterThan(0)
    expect(existsSync(join(to, 'database.sqlite'))).toBe(false)
  })

  it('refuses a destination that already contains data', async () => {
    const { from, to } = setup()
    await importKomga({ from, to })
    await expect(importKomga({ from, to })).rejects.toThrow(/already contains data/)
  })

  it('allows re-import with force without duplicating rows', async () => {
    const { from, to } = setup()
    const first = await importKomga({ from, to })
    const second = await importKomga({ from, to, force: true })

    const count = (report: typeof first, table: string) =>
      report.tables.find((entry) => entry.table === table)?.rows ?? 0
    expect(count(second, 'libraries')).toBe(count(first, 'libraries'))
    expect(count(second, 'books')).toBe(count(first, 'books'))
    expect(count(second, 'thumbnails')).toBe(count(first, 'thumbnails'))
    expect(second.totalRows).toBe(first.totalRows)

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      expect((await database.db.selectFrom('books').selectAll().execute()).length).toBe(2)
      expect((await database.db.selectFrom('server_settings').selectAll().execute()).length).toBe(2)
    } finally {
      await database.close()
    }
  })

  it('imports identity only in rescan-only mode', async () => {
    const { from, to } = setup()
    const report = await importKomga({ from, to, rescanOnly: true })
    expect(report.warnings.join(' ')).toMatch(/Rescan-only/)

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      expect((await database.db.selectFrom('libraries').selectAll().execute()).length).toBe(1)
      expect((await database.db.selectFrom('users').selectAll().execute()).length).toBe(2)
      expect((await database.db.selectFrom('books').selectAll().execute()).length).toBe(0)
    } finally {
      await database.close()
    }
  })
})
