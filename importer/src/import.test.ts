import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../../server/src/db/index.js'
import { importKomga, isoDate } from './import.js'
import { komgaPath, parseMapping, type PathMapping } from './paths.js'
import { createLegacyFixture } from './testing/legacy-fixture.js'

/**
 * The fixture is a Komga database whose library was at `/library` on Komga's
 * machine. Here the books are in a folder of the test's own, which `--map` names.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-import-'))
  const from = join(dir, 'legacy')
  mkdirSync(from, { recursive: true })
  createLegacyFixture(join(from, 'database.sqlite'))
  const books = join(dir, 'books')
  mkdirSync(join(books, 'Akira'), { recursive: true })
  for (const name of ['Volume 1.cbz', 'Volume 2.cbz', 'Volume 1.png']) writeFileSync(join(books, 'Akira', name), '')
  const map: PathMapping[] = [{ from: '/library', to: [books] }]
  return { dir, from, to: join(dir, 'target'), books, map }
}

const url = (...parts: string[]) => pathToFileURL(join(...parts)).href

describe('komga-import', () => {
  it('imports identity, content, progress and artwork', async () => {
    const { from, to, books, map } = setup()
    const report = await importKomga({ from, to, map, timezone: 'UTC' })
    expect(report.totalRows).toBeGreaterThan(0)
    expect(report.migrations.length).toBeGreaterThan(0)

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      const libraries = await database.db.selectFrom('libraries').selectAll().execute()
      expect(libraries.map((library) => library.name)).toEqual(['Library'])
      expect(libraries[0]?.root).toBe(books)
      // Komga's column is SCAN_STARTUP.
      expect(libraries[0]?.scan_on_startup).toBe(1)
      // The exclusions are in the column the settings screen saves back, as well as their table.
      expect(libraries[0]?.scan_directory_exclusions).toBe('["#recycle"]')

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

      // Every location is the URL a scan of the new folder would store, or the first
      // scan would take every imported book for one that has gone.
      const series = await database.db.selectFrom('series').selectAll().execute()
      expect(series.map((row) => [row.name, row.url])).toEqual([['Akira', url(books, 'Akira')]])

      const seriesMetadata = await database.db.selectFrom('series_metadata').selectAll().execute()
      expect(seriesMetadata[0]?.status).toBe('ENDED')
      expect(seriesMetadata[0]?.title_lock).toBe(1)
      expect(seriesMetadata[0]?.publisher).toBe('Kodansha')
      // Locks for the list-valued fields are columns too, and a locked field must
      // survive the move or a later scan would overwrite hand-edited metadata.
      expect(seriesMetadata[0]?.tags_lock).toBe(1)
      expect(seriesMetadata[0]?.genres_lock).toBe(0)

      expect((await database.db.selectFrom('series_metadata_author').selectAll().execute()).length).toBe(1)
      expect((await database.db.selectFrom('series_metadata_sharing').selectAll().execute()).length).toBe(1)

      const imported = await database.db.selectFrom('books').selectAll().orderBy('number').execute()
      expect(imported.map((book) => [book.name, book.url])).toEqual([
        ['Volume 1', url(books, 'Akira', 'Volume 1.cbz')],
        ['Volume 2', url(books, 'Akira', 'Volume 2.cbz')],
      ])
      expect(imported[0]?.file_size).toBe(1024)
      // Nanoseconds, in UTC, kept to the millisecond.
      expect(imported[1]?.file_last_modified).toBe('2024-01-02T10:00:00.123Z')

      const bookMetadata = await database.db.selectFrom('book_metadata').selectAll().orderBy('book_id').execute()
      expect(bookMetadata[0]?.title).toBe('Akira Volume One')
      expect(bookMetadata[0]?.number_sort).toBe(1)
      expect(bookMetadata[0]?.links_lock).toBe(1)
      expect(bookMetadata[1]?.links_lock).toBe(0)

      // What Komga worked out of a series' books comes too, so nothing has to be read again.
      expect(await database.db.selectFrom('book_metadata_aggregation').selectAll().execute()).toMatchObject([
        { series_id: 'S1', release_date: '1982-12-20', summary: 'Neo-Tokyo, 2019.', summary_number: '1' },
      ])
      expect(await database.db.selectFrom('book_metadata_aggregation_author').selectAll().execute()).toEqual([
        { series_id: 'S1', name: 'Katsuhiro Otomo', role: 'writer' },
      ])
      expect(await database.db.selectFrom('book_metadata_aggregation_tag').selectAll().execute()).toEqual([
        { series_id: 'S1', tag: 'cyberpunk' },
      ])

      expect((await database.db.selectFrom('media').selectAll().execute()).length).toBe(2)
      expect(await database.db.selectFrom('media_file').selectAll().execute()).toEqual([
        { book_id: 'B1', file_name: 'ComicInfo.xml' },
      ])
      const pages = await database.db.selectFrom('media_page').selectAll().orderBy('book_id').execute()
      expect(pages[0]?.width).toBe(800)
      // A page's hash travels with the page, which is where the API reads it from.
      expect(pages.map((page) => page.file_hash)).toEqual(['hash-1', 'hash-1'])

      const thumbnails = await database.db
        .selectFrom('thumbnails')
        .selectAll()
        .orderBy('owner_type')
        .orderBy('id')
        .execute()
      expect(thumbnails.map((row) => row.owner_type)).toEqual(['BOOK', 'BOOK', 'SERIES'])
      expect(thumbnails[0]?.thumbnail?.length).toBe(4)
      expect(thumbnails[0]?.url).toBeNull()
      // A cover kept as a file beside the book moves across as its URL, with no bytes.
      expect(thumbnails[1]?.type).toBe('SIDECAR')
      expect(thumbnails[1]?.thumbnail).toBeNull()
      expect(thumbnails[1]?.url).toBe(url(books, 'Akira', 'Volume 1.png'))

      const progress = await database.db.selectFrom('read_progress').selectAll().execute()
      expect(progress[0]?.page).toBe(42)
      expect(progress[0]?.read_date).toBe('2024-02-01T12:00:00.000Z')
      expect(await database.db.selectFrom('read_progress_series').selectAll().execute()).toMatchObject([
        {
          user_id: 'U1',
          series_id: 'S1',
          read_count: 0,
          in_progress_count: 1,
          most_recent_read_date: '2024-02-01T12:00:00.500Z',
        },
      ])

      const collections = await database.db.selectFrom('collections').selectAll().execute()
      expect(collections[0]?.name).toBe('Favourites')
      expect(collections[0]?.series_count).toBe(1)

      const readLists = await database.db.selectFrom('readlists').selectAll().execute()
      expect(readLists[0]?.book_count).toBe(1)

      const settings = await database.db.selectFrom('server_settings').selectAll().orderBy('key').execute()
      expect(settings.map((row) => row.key)).toContain('REMEMBER_ME_KEY')

      const clientSettings = await database.db.selectFrom('client_settings_user').selectAll().execute()
      expect(clientSettings).toEqual([{ user_id: 'U1', key: 'WEBUI_POSTER_STRETCH', value: 'true' }])

      const hashes = await database.db.selectFrom('page_hash').selectAll().execute()
      expect(hashes).toHaveLength(1)
      expect(hashes[0]).toMatchObject({ hash: 'hash-1', size: 512, action: 'DELETE_AUTO', delete_count: 2 })
      expect((await database.db.selectFrom('page_hash_thumbnail').selectAll().execute()).length).toBe(1)
    } finally {
      await database.close()
    }

    // What is not carried over is said, not left to be discovered.
    expect(report.warnings.join('\n')).toMatch(/Not carried over: API keys.*\(1 rows of USER_API_KEY\)/)
  })

  it('makes imported content searchable through FTS5', async () => {
    const { from, to, map } = setup()
    await importKomga({ from, to, map })

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
    const { from, to, map } = setup()
    const report = await importKomga({ from, to, map, dryRun: true })
    expect(report.totalRows).toBeGreaterThan(0)
    expect(existsSync(join(to, 'database.sqlite'))).toBe(false)
  })

  it('refuses a destination that already contains data', async () => {
    const { from, to, map } = setup()
    await importKomga({ from, to, map })
    await expect(importKomga({ from, to, map })).rejects.toThrow(/already contains data/)
  })

  it('allows re-import with force without duplicating rows', async () => {
    const { from, to, map } = setup()
    const first = await importKomga({ from, to, map })
    const second = await importKomga({ from, to, map, force: true })

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
    const { from, to, map } = setup()
    const report = await importKomga({ from, to, map, rescanOnly: true })
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

  it('leaves the destination as it was when a row cannot be written', async () => {
    const { from, to, map } = setup()
    // A book of a series Komga no longer has: the database refuses it, late in the run.
    const legacy = new BetterSqlite3(join(from, 'database.sqlite'))
    legacy
      .prepare(
        "insert into BOOK (ID, SERIES_ID, LIBRARY_ID, NAME, URL, FILE_LAST_MODIFIED) values ('B9', 'gone', 'L1', 'Orphan', 'file:/library/x.cbz', '2024-01-01 00:00:00')",
      )
      .run()
    legacy.close()

    await expect(importKomga({ from, to, map })).rejects.toThrow(/books: FOREIGN KEY constraint failed/)
    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      expect(await database.db.selectFrom('libraries').selectAll().execute()).toEqual([])
      expect(await database.db.selectFrom('users').selectAll().execute()).toEqual([])
    } finally {
      await database.close()
    }
  })
})

describe('where the books are now', () => {
  it('puts a library in the first of the places given that has it', async () => {
    const { dir, from, to, books } = setup()
    const report = await importKomga({ from, to, map: [{ from: '/library', to: [join(dir, 'elsewhere'), books] }] })
    expect(report.libraries).toMatchObject([{ name: 'Library', komga: '/library', root: books, found: true }])
    expect(report.warnings.join('\n')).not.toMatch(/no folder at their new root/)
  })

  it('names books by the folder as the system resolves it, as a scan does', async () => {
    // A link to the books stands in for a mapped drive: a scan resolves the root to
    // what is behind it and names every book from there, so the import must too.
    const { dir, from, to, books } = setup()
    const link = join(dir, 'linked')
    symlinkSync(books, link, 'junction')
    const report = await importKomga({ from, to, map: [{ from: '/library', to: [link] }] })
    expect(report.libraries).toMatchObject([{ root: link, resolved: realpathSync.native(books), found: true }])

    const database = createDatabase(join(to, 'database.sqlite'))
    try {
      const imported = await database.db.selectFrom('books').select('url').orderBy('number').execute()
      expect(imported[0]?.url).toBe(url(realpathSync.native(books), 'Akira', 'Volume 1.cbz'))
    } finally {
      await database.close()
    }
  })

  it('says when a library is in none of them, and keeps the first', async () => {
    const { dir, from, to } = setup()
    const report = await importKomga({ from, to, map: [{ from: '/library', to: [join(dir, 'gone')] }] })
    expect(report.libraries).toMatchObject([{ root: join(dir, 'gone'), found: false }])
    expect(report.warnings.join('\n')).toMatch(/1 of 1 libraries have no folder at their new root: Library/)
  })

  it('says which book files are not where the import put them', async () => {
    const { from, to, books, map } = setup()
    rmSync(join(books, 'Akira', 'Volume 2.cbz'))
    const report = await importKomga({ from, to, map, checkFiles: true, timezone: 'UTC' })
    expect(report.missingFiles).toMatchObject({
      checked: 2,
      missing: 1,
      examples: [join(books, 'Akira', 'Volume 2.cbz')],
      byLibrary: [{ library: 'Library', missing: 1 }],
    })
  })

  it('reads the locations Komga writes', () => {
    expect(komgaPath('file:/srv/manga/One%20Piece/')).toBe('/srv/manga/One Piece')
    expect(komgaPath('file:///srv/manga/a.cbz')).toBe('/srv/manga/a.cbz')
    expect(komgaPath('file:/C:/Comics/a%23b.cbz')).toBe('C:/Comics/a#b.cbz')
    // A `%` that starts no escape is part of the name.
    expect(komgaPath('file:/srv/100%.cbz')).toBe('/srv/100%.cbz')
    expect(parseMapping('/srv/manga=/mnt/a=b')).toEqual({ from: '/srv/manga', to: '/mnt/a=b' })
    expect(() => parseMapping('/srv/manga')).toThrow(/old=new/)
  })
})

describe('dates', () => {
  it('reads them as local times of the zone Komga ran in', () => {
    const fallback = 'fallback'
    // Summer and winter time in Central Europe, and New York.
    expect(isoDate('2026-05-25 18:22:10.603', fallback, 'Europe/Berlin')).toBe('2026-05-25T16:22:10.603Z')
    expect(isoDate('2026-01-15 18:22:10', fallback, 'Europe/Berlin')).toBe('2026-01-15T17:22:10.000Z')
    expect(isoDate('2026-07-04 08:00:00', fallback, 'America/New_York')).toBe('2026-07-04T12:00:00.000Z')
    // Either side of the change to summer time, on 29 March 2026 at 02:00 local.
    expect(isoDate('2026-03-29 01:30:00', fallback, 'Europe/Berlin')).toBe('2026-03-29T00:30:00.000Z')
    expect(isoDate('2026-03-29 03:30:00', fallback, 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z')
    // A date that says its own offset keeps it.
    expect(isoDate('2026-05-25T18:22:10Z', fallback, 'Europe/Berlin')).toBe('2026-05-25T18:22:10.000Z')
  })

  it('are compared with the files, so a wrong zone shows before a scan reads everything again', async () => {
    const { from, to, books, map } = setup()
    // Komga's machine was in Berlin; the files carry the times it saw. A file's time
    // is the later of its creation and its last change, so these are after both.
    const legacy = new BetterSqlite3(join(from, 'database.sqlite'))
    legacy.prepare("update BOOK set FILE_LAST_MODIFIED = '2040-01-01 10:00:00' where ID = 'B1'").run()
    legacy.prepare("update BOOK set FILE_LAST_MODIFIED = '2040-01-02 10:00:00.123' where ID = 'B2'").run()
    legacy.close()
    const when = (local: string) => new Date(isoDate(local, '', 'Europe/Berlin'))
    utimesSync(join(books, 'Akira', 'Volume 1.cbz'), when('2040-01-01 10:00:00'), when('2040-01-01 10:00:00'))
    utimesSync(join(books, 'Akira', 'Volume 2.cbz'), when('2040-01-02 10:00:00.123'), when('2040-01-02 10:00:00.123'))

    const right = await importKomga({ from, to, map, checkFiles: true, timezone: 'Europe/Berlin', dryRun: true })
    expect(right.missingFiles).toMatchObject({ timesMatching: 2, timeDifferences: [] })

    const wrong = await importKomga({ from, to, map, checkFiles: true, timezone: 'UTC', dryRun: true })
    expect(wrong.missingFiles).toMatchObject({ timesMatching: 0, timeDifferences: [{ hours: 1, files: 2 }] })
  })

  it('reads what Komga writes as UTC, to the millisecond', () => {
    const fallback = 'fallback'
    expect(isoDate('2026-05-03 18:06:09', fallback)).toBe('2026-05-03T18:06:09.000Z')
    expect(isoDate('2026-05-03 18:06:09.453855279', fallback)).toBe('2026-05-03T18:06:09.453Z')
    expect(isoDate('2024-05-24 01:05:26.17', fallback)).toBe('2024-05-24T01:05:26.170Z')
    expect(isoDate('2024-05-24T01:05:26+02:00', fallback)).toBe('2024-05-23T23:05:26.000Z')
    expect(isoDate(1717000000000, fallback)).toBe('2024-05-29T16:26:40.000Z')
    expect(isoDate(null, fallback)).toBe(fallback)
    expect(isoDate('not a date', fallback)).toBe(fallback)
  })
})
