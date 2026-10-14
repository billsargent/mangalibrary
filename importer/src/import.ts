import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Kysely } from 'kysely'
import type BetterSqlite3 from 'better-sqlite3'
import type { Database } from '../../server/src/db/index.js'
import { createDatabase } from '../../server/src/db/index.js'
import { migrate } from '../../server/src/db/migrate.js'
import { migrations } from '../../server/src/db/migrations/index.js'
import type { DB } from '../../server/src/db/schema.js'
import { localZone, zonedToEpoch } from './dates.js'
import { LegacyDatabase, type LegacyRow } from './legacy.js'
import { fileTime, Relocator, type LibraryPlacement, type PathMapping } from './paths.js'

export interface ImportOptions {
  /** Legacy Komga config directory (contains `database.sqlite`). */
  from: string
  /** Destination config directory for the new database. */
  to: string
  /** Report only; nothing is written. */
  dryRun?: boolean
  /** Import identity and settings only; content is re-scanned from disk. */
  rescanOnly?: boolean
  /** Allow writing into a destination that already contains data. */
  force?: boolean
  /** Where folders Komga knew have gone. */
  map?: readonly PathMapping[]
  /** Look for every book's file where the import says it is, and report the ones not there. */
  checkFiles?: boolean
  /**
   * The time zone Komga ran in, which every date it stored is a local time of
   * (`Europe/Berlin`, `America/New_York`, `UTC` for most containers). This
   * machine's zone when not given.
   */
  timezone?: string
  /** Told a line at a time what is happening: a large import takes minutes. */
  progress?: (line: string) => void
}

export interface TableCount {
  table: string
  rows: number
}

export interface MissingFiles {
  checked: number
  missing: number
  /**
   * Of the files found, how many have the modification time Komga recorded, and
   * how far off the others are, most common first. A whole number of hours for
   * nearly all of them means Komga ran in another zone than the one given.
   */
  timesMatching: number
  timeDifferences: { hours: number; files: number }[]
  /** Up to ten of them, for the person importing to look at. */
  examples: string[]
  /** How many are missing in each library that is missing any. */
  byLibrary: { library: string; missing: number }[]
}

export interface ImportReport {
  from: string
  to: string
  dryRun: boolean
  migrations: string[]
  tables: TableCount[]
  totalRows: number
  libraries: LibraryPlacement[]
  timezone: string
  missingFiles: MissingFiles | null
  warnings: string[]
}

type Row = Record<string, unknown>

interface Context {
  legacy: LegacyDatabase
  relocator: Relocator
  timestamp: string
  /** The zone Komga's dates are local times of. */
  zone: string
  /** Where each book's file should now be, and its time, kept only when files are to be checked. */
  bookPaths: { libraryId: string; path: string; modified: string }[] | null
}

// ------------------------------------------------------------------ helpers

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value)
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

function bool(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  return value === 0 || value === '0' || value === false ? 0 : 1
}

function number(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : number(value))

/**
 * A Komga date, as this server writes dates: ISO 8601 in UTC.
 *
 * Komga writes `YYYY-MM-DD HH:MM:SS`, with up to nine digits of fraction, as a
 * local time of the zone it ran in (see `dates.ts`). A date that says its own
 * offset is read by it, anything else that is a date is read as one, and a
 * number as milliseconds.
 */
export function isoDate(value: unknown, fallback: string, zone = 'UTC'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const raw = nullableText(value)
  if (!raw) return fallback
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw)
  if (match) {
    const millis = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    const parsed = new Date(`${match[1]}T${match[2]}.${millis}${match[4] ?? 'Z'}`)
    if (!Number.isNaN(parsed.getTime())) {
      return match[4] === undefined
        ? new Date(zonedToEpoch(parsed.getTime(), zone)).toISOString()
        : parsed.toISOString()
    }
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

const nullableDate = (value: unknown, timestamp: string, zone: string): string | null =>
  nullableText(value) === null ? null : isoDate(value, timestamp, zone)

function jsonArray(values: unknown[]): string {
  return JSON.stringify(values.filter((value) => value !== null && value !== undefined).map((value) => String(value)))
}

/** Komga keeps an EPUB reading position gzipped; this server keeps it as the JSON it was. */
function locatorText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    try {
      return gunzipSync(value).toString('utf8')
    } catch {
      return value.toString('utf8')
    }
  }
  return nullableText(value)
}

/** Count a legacy table's rows by one column, for totals that Komga does not keep. */
function countsBy(legacy: LegacyDatabase, table: string, column: string): Map<string, number> {
  if (!legacy.hasColumns(table, column)) return new Map()
  return new Map(
    legacy
      .query(`select "${column}" as k, count(*) as n from "${table}" group by "${column}"`)
      .map((row) => [text(row.K), number(row.N)]),
  )
}

// ------------------------------------------------------------------ tables

/**
 * One table of the new database: where its rows come from in Komga, and how each
 * is made. A row the mapper gives `null` for is left out.
 */
interface Copy {
  table: keyof DB
  from: string
  map: (row: LegacyRow, context: Context) => Row | null
  /** Set up before the first row: totals, lookups. */
  prepare?: (context: Context) => (row: LegacyRow, context: Context) => Row | null
}

function libraryCopy(): Copy {
  return {
    table: 'libraries',
    from: 'LIBRARY',
    map: () => null,
    prepare: ({ legacy }) => {
      const exclusions = new Map<string, string[]>()
      for (const row of legacy.iterate('LIBRARY_EXCLUSIONS')) {
        const id = text(row.LIBRARY_ID)
        const list = exclusions.get(id) ?? []
        if (text(row.EXCLUSION) !== '') list.push(text(row.EXCLUSION))
        exclusions.set(id, list)
      }
      return (row, { relocator, timestamp, zone }) => {
        const id = text(row.ID)
        const placement = relocator.placeLibrary(id, text(row.NAME), text(row.ROOT))
        return {
          id,
          name: text(row.NAME),
          root: placement.root,
          import_comic_info_book: bool(row.IMPORT_COMICINFO_BOOK, 1),
          import_comic_info_series: bool(row.IMPORT_COMICINFO_SERIES, 1),
          import_comic_info_collection: bool(row.IMPORT_COMICINFO_COLLECTION, 1),
          import_comic_info_read_list: bool(row.IMPORT_COMICINFO_READLIST, 1),
          import_comic_info_series_append_volume: bool(row.IMPORT_COMICINFO_SERIES_APPEND_VOLUME, 1),
          import_epub_book: bool(row.IMPORT_EPUB_BOOK, 1),
          import_epub_series: bool(row.IMPORT_EPUB_SERIES, 1),
          import_mylar_series: bool(row.IMPORT_MYLAR_SERIES, 1),
          import_local_artwork: bool(row.IMPORT_LOCAL_ARTWORK, 1),
          import_barcode_isbn: bool(row.IMPORT_BARCODE_ISBN, 1),
          scan_force_modified_time: bool(row.SCAN_FORCE_MODIFIED_TIME, 0),
          // Komga's column is SCAN_STARTUP; an older name is read too, in case.
          scan_on_startup: bool(row.SCAN_STARTUP ?? row.SCAN_ON_STARTUP, 0),
          scan_interval: text(row.SCAN_INTERVAL, 'EVERY_6H'),
          scan_cbx: bool(row.SCAN_CBX, 1),
          scan_pdf: bool(row.SCAN_PDF, 1),
          scan_epub: bool(row.SCAN_EPUB, 1),
          // The library's own column is what the settings screen shows and saves back,
          // so the exclusions go there as well as into their table.
          scan_directory_exclusions: JSON.stringify(exclusions.get(id) ?? []),
          repair_extensions: bool(row.REPAIR_EXTENSIONS, 0),
          convert_to_cbz: bool(row.CONVERT_TO_CBZ, 0),
          empty_trash_after_scan: bool(row.EMPTY_TRASH_AFTER_SCAN, 0),
          series_cover: text(row.SERIES_COVER, 'FIRST'),
          hash_files: bool(row.HASH_FILES, 1),
          hash_pages: bool(row.HASH_PAGES, 0),
          hash_koreader: bool(row.HASH_KOREADER, 0),
          analyze_dimensions: bool(row.ANALYZE_DIMENSIONS, 1),
          oneshots_directory: nullableText(row.ONESHOTS_DIRECTORY),
          unavailable_date: nullableDate(row.UNAVAILABLE_DATE, timestamp, zone),
          created_date: isoDate(row.CREATED_DATE, timestamp, zone),
          last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
        }
      }
    },
  }
}

const libraryExclusions: Copy = {
  table: 'library_exclusions',
  from: 'LIBRARY_EXCLUSIONS',
  map: (row) =>
    text(row.LIBRARY_ID) === '' || text(row.EXCLUSION) === ''
      ? null
      : { library_id: text(row.LIBRARY_ID), exclusion: text(row.EXCLUSION) },
}

const users: Copy = {
  table: 'users',
  from: 'USER',
  map: () => null,
  prepare: ({ legacy }) => {
    // Komga tells `Ann@example.com` and `ann@example.com` apart; this server signs in
    // by email whatever its case, so two such accounts cannot both come across, and
    // which one should is for a person to decide, before anything is written.
    const byEmail = new Map<string, string[]>()
    for (const row of legacy.iterate('USER')) {
      const email = text(row.EMAIL)
      byEmail.set(email.toLowerCase(), [...(byEmail.get(email.toLowerCase()) ?? []), email])
    }
    const clashes = [...byEmail.values()].filter((emails) => emails.length > 1)
    if (clashes.length > 0) {
      throw new Error(
        `Komga has accounts whose emails differ only in case, which this server cannot tell apart: ${clashes
          .map((emails) => emails.join(' and '))
          .join('; ')}. Change one of each in Komga, then import again.`,
      )
    }

    const rolesByUser = new Map<string, string[]>()
    for (const row of legacy.iterate('USER_ROLE')) {
      const userId = text(row.USER_ID)
      const role = text(row.ROLE)
      if (!userId || !role) continue
      rolesByUser.set(userId, [...(rolesByUser.get(userId) ?? []), role])
    }
    return (row, { timestamp, zone }) => {
      const id = text(row.ID)
      // Role flags on the user row predate the USER_ROLE table.
      const inlineRoles: string[] = []
      if (bool(row.ROLE_ADMIN, 0)) inlineRoles.push('ADMIN')
      if (bool(row.ROLE_FILE_DOWNLOAD, 0)) inlineRoles.push('FILE_DOWNLOAD')
      if (bool(row.ROLE_PAGE_STREAMING, 0)) inlineRoles.push('PAGE_STREAMING')
      if (bool(row.ROLE_KOBO_SYNC, 0)) inlineRoles.push('KOBO_SYNC')
      if (bool(row.ROLE_KOREADER_SYNC, 0)) inlineRoles.push('KOREADER_SYNC')
      return {
        id,
        email: text(row.EMAIL),
        password: text(row.PASSWORD),
        roles: jsonArray(rolesByUser.get(id) ?? inlineRoles),
        shared_all_libraries: bool(row.SHARED_ALL_LIBRARIES, 1),
        age_restriction: nullableNumber(row.AGE_RESTRICTION),
        age_restriction_allow_only:
          row.AGE_RESTRICTION_ALLOW_ONLY === null || row.AGE_RESTRICTION_ALLOW_ONLY === undefined
            ? null
            : bool(row.AGE_RESTRICTION_ALLOW_ONLY, 1),
        created_date: isoDate(row.CREATED_DATE, timestamp, zone),
        last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
      }
    }
  },
}

const pair = (table: keyof DB, from: string, columns: [string, string][]): Copy => ({
  table,
  from,
  map: (row) => {
    const out: Row = {}
    for (const [target, source] of columns) {
      const value = text(row[source])
      if (value === '') return null
      out[target] = value
    }
    return out
  },
})

/**
 * API keys, as Komga keeps them: the hex SHA-512 of each key, which is what this
 * server keeps too, so a key a reader app already holds goes on working.
 */
const apiKeys: Copy = {
  table: 'user_api_keys',
  from: 'USER_API_KEY',
  map: (row, { timestamp, zone }) => {
    const key = text(row.API_KEY)
    if (text(row.ID) === '' || text(row.USER_ID) === '' || key === '') return null
    return {
      id: text(row.ID),
      user_id: text(row.USER_ID),
      key,
      comment: text(row.COMMENT),
      created_date: isoDate(row.CREATED_DATE, timestamp, zone),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
    }
  },
}

/**
 * Labels a reader may or may not see. Komga keys these by label, allow and user, so a
 * label can be both allowed and excluded for one reader; this server keeps one row a
 * label, and - as it decides when it reads them - exclusion wins.
 */
const userSharing: Copy = {
  table: 'user_sharing',
  from: 'USER_SHARING',
  map: () => null,
  prepare: ({ legacy }) => {
    const excluded = new Set(
      legacy
        .rows('USER_SHARING')
        .filter((row) => !bool(row.ALLOW, 1))
        .map((row) => `${text(row.USER_ID)}\u0000${text(row.LABEL)}`),
    )
    const seen = new Set<string>()
    return (row) => {
      const key = `${text(row.USER_ID)}\u0000${text(row.LABEL)}`
      if (text(row.USER_ID) === '' || text(row.LABEL) === '' || seen.has(key)) return null
      const allow = excluded.has(key) ? 0 : bool(row.ALLOW, 1)
      seen.add(key)
      return { user_id: text(row.USER_ID), allow, label: text(row.LABEL) }
    }
  },
}

const series: Copy = {
  table: 'series',
  from: 'SERIES',
  map: () => null,
  prepare: ({ legacy }) => {
    const counts = countsBy(legacy, 'BOOK', 'SERIES_ID')
    return (row, { relocator, timestamp, zone }) => {
      const id = text(row.ID)
      return {
        id,
        library_id: text(row.LIBRARY_ID),
        name: text(row.NAME),
        url: relocator.url(text(row.URL)),
        file_last_modified: isoDate(row.FILE_LAST_MODIFIED, timestamp, zone),
        book_count: number(row.BOOK_COUNT, counts.get(id) ?? 0),
        oneshot: bool(row.ONESHOT, 0),
        deleted_date: nullableDate(row.DELETED_DATE, timestamp, zone),
        created_date: isoDate(row.CREATED_DATE, timestamp, zone),
        last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
      }
    }
  },
}

const seriesMetadata: Copy = {
  table: 'series_metadata',
  from: 'SERIES_METADATA',
  map: (row, { timestamp, zone }) => ({
    series_id: text(row.SERIES_ID),
    status: text(row.STATUS, 'ONGOING'),
    status_lock: bool(row.STATUS_LOCK, 0),
    title: text(row.TITLE),
    title_lock: bool(row.TITLE_LOCK, 0),
    title_sort: text(row.TITLE_SORT, text(row.TITLE)),
    title_sort_lock: bool(row.TITLE_SORT_LOCK, 0),
    publisher: text(row.PUBLISHER, ''),
    publisher_lock: bool(row.PUBLISHER_LOCK, 0),
    language: text(row.LANGUAGE, ''),
    language_lock: bool(row.LANGUAGE_LOCK, 0),
    age_rating: nullableNumber(row.AGE_RATING),
    age_rating_lock: bool(row.AGE_RATING_LOCK, 0),
    reading_direction: nullableText(row.READING_DIRECTION),
    reading_direction_lock: bool(row.READING_DIRECTION_LOCK, 0),
    summary: text(row.SUMMARY, ''),
    summary_lock: bool(row.SUMMARY_LOCK, 0),
    total_book_count: nullableNumber(row.TOTAL_BOOK_COUNT),
    total_book_count_lock: bool(row.TOTAL_BOOK_COUNT_LOCK, 0),
    sharing_labels_lock: bool(row.SHARING_LABELS_LOCK, 0),
    tags_lock: bool(row.TAGS_LOCK, 0),
    genres_lock: bool(row.GENRES_LOCK, 0),
    links_lock: bool(row.LINKS_LOCK, 0),
    alternate_titles_lock: bool(row.ALTERNATE_TITLES_LOCK, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

const links = (table: keyof DB, from: string, owner: string): Copy => ({
  table,
  from,
  map: (row) => {
    const id = text(row[owner.toUpperCase()])
    const url = text(row.URL)
    return id === '' || url === '' ? null : { [owner]: id, label: text(row.LABEL), url }
  },
})

const books: Copy = {
  table: 'books',
  from: 'BOOK',
  map: (row, context) => {
    const path = context.relocator.path(text(row.URL))
    const modified = isoDate(row.FILE_LAST_MODIFIED, context.timestamp, context.zone)
    context.bookPaths?.push({ libraryId: text(row.LIBRARY_ID), path, modified })
    return {
      id: text(row.ID),
      series_id: text(row.SERIES_ID),
      library_id: text(row.LIBRARY_ID),
      name: text(row.NAME),
      url: context.relocator.url(text(row.URL)),
      file_last_modified: modified,
      file_size: number(row.FILE_SIZE, 0),
      file_hash: nullableText(row.FILE_HASH),
      file_hash_koreader: nullableText(row.FILE_HASH_KOREADER),
      number: number(row.NUMBER, 0),
      oneshot: bool(row.ONESHOT, 0),
      deleted_date: nullableDate(row.DELETED_DATE, context.timestamp, context.zone),
      created_date: isoDate(row.CREATED_DATE, context.timestamp, context.zone),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, context.timestamp, context.zone),
    }
  },
}

const bookMetadata: Copy = {
  table: 'book_metadata',
  from: 'BOOK_METADATA',
  map: (row, { timestamp, zone }) => ({
    book_id: text(row.BOOK_ID),
    title: text(row.TITLE),
    title_lock: bool(row.TITLE_LOCK, 0),
    number: text(row.NUMBER, ''),
    number_lock: bool(row.NUMBER_LOCK, 0),
    number_sort: number(row.NUMBER_SORT, 0),
    number_sort_lock: bool(row.NUMBER_SORT_LOCK, 0),
    release_date: nullableText(row.RELEASE_DATE),
    release_date_lock: bool(row.RELEASE_DATE_LOCK, 0),
    summary: text(row.SUMMARY, ''),
    summary_lock: bool(row.SUMMARY_LOCK, 0),
    publisher: text(row.PUBLISHER, ''),
    publisher_lock: bool(row.PUBLISHER_LOCK, 0),
    isbn: text(row.ISBN, ''),
    isbn_lock: bool(row.ISBN_LOCK, 0),
    age_rating: nullableNumber(row.AGE_RATING),
    age_rating_lock: bool(row.AGE_RATING_LOCK, 0),
    reading_direction: nullableText(row.READING_DIRECTION),
    reading_direction_lock: bool(row.READING_DIRECTION_LOCK, 0),
    authors_lock: bool(row.AUTHORS_LOCK, 0),
    tags_lock: bool(row.TAGS_LOCK, 0),
    links_lock: bool(row.LINKS_LOCK, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

const authors = (table: keyof DB, from: string, owner: string): Copy => ({
  table,
  from,
  map: (row) => {
    const id = text(row[owner.toUpperCase()])
    const name = text(row.NAME)
    return id === '' || name === '' ? null : { [owner]: id, name, role: text(row.ROLE) }
  },
})

/**
 * What Komga worked out of a series' books: its summary, release date, authors and
 * tags. Carried over so a series reads as it did without every book being read again.
 */
const aggregation: Copy = {
  table: 'book_metadata_aggregation',
  from: 'BOOK_METADATA_AGGREGATION',
  map: (row, { timestamp, zone }) => ({
    series_id: text(row.SERIES_ID),
    summary: text(row.SUMMARY, ''),
    summary_number: text(row.SUMMARY_NUMBER, ''),
    release_date: nullableText(row.RELEASE_DATE),
    created_date: isoDate(row.CREATED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

/**
 * What Komga made of each book. An EPUB's contents and reading positions are kept by
 * this server in tables of its own that Komga's do not fill, so an analysed EPUB
 * comes across as OUTDATED and is read again once - which is quick, and rare.
 */
const media: Copy = {
  table: 'media',
  from: 'MEDIA',
  map: (row, { timestamp, zone }) => ({
    book_id: text(row.BOOK_ID),
    media_type: nullableText(row.MEDIA_TYPE),
    status:
      text(row.MEDIA_TYPE) === 'application/epub+zip' && text(row.STATUS) === 'READY'
        ? 'OUTDATED'
        : text(row.STATUS, 'UNKNOWN'),
    comment: nullableText(row.COMMENT),
    page_count: number(row.PAGE_COUNT, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

const mediaPages: Copy = {
  table: 'media_page',
  from: 'MEDIA_PAGE',
  map: (row) => ({
    book_id: text(row.BOOK_ID),
    number: number(row.NUMBER, 0),
    file_name: text(row.FILE_NAME),
    media_type: text(row.MEDIA_TYPE),
    width: nullableNumber(row.WIDTH),
    height: nullableNumber(row.HEIGHT),
    file_size: nullableNumber(row.FILE_SIZE),
    // A page's hash lives with the page in Komga too; the column arrived after the table.
    file_hash: text(row.FILE_HASH, ''),
  }),
}

const mediaFiles: Copy = {
  table: 'media_file',
  from: 'MEDIA_FILE',
  map: (row) => (text(row.BOOK_ID) === '' ? null : { book_id: text(row.BOOK_ID), file_name: text(row.FILE_NAME) }),
}

const thumbnails = (from: string, ownerType: string, ownerColumn: string): Copy => ({
  table: 'thumbnails',
  from,
  map: (row, { relocator, timestamp, zone }) => {
    // Komga keeps a thumbnail as bytes, or as the URL of a file it found beside the book.
    const blob = (row.THUMBNAIL ?? null) as Buffer | null
    const url = nullableText(row.URL)
    const owner = text(row[ownerColumn])
    if ((blob === null && url === null) || owner === '') return null
    return {
      id: text(row.ID),
      owner_type: ownerType,
      owner_id: owner,
      type: text(row.TYPE, 'GENERATED'),
      page: number(row.PAGE, 0),
      selected: bool(row.SELECTED, 1),
      media_type: text(row.MEDIA_TYPE, 'image/jpeg'),
      width: number(row.WIDTH, 0),
      height: number(row.HEIGHT, 0),
      file_size: number(row.FILE_SIZE, blob === null ? 0 : blob.length),
      thumbnail: blob,
      url: url === null ? null : relocator.url(url),
      created_date: isoDate(row.CREATED_DATE, timestamp, zone),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
    }
  },
})

const readProgress: Copy = {
  table: 'read_progress',
  from: 'READ_PROGRESS',
  map: (row, { timestamp, zone }) => ({
    user_id: text(row.USER_ID),
    book_id: text(row.BOOK_ID),
    page: number(row.PAGE, 0),
    completed: bool(row.COMPLETED, 0),
    read_date: nullableDate(row.READ_DATE, timestamp, zone),
    device_id: nullableText(row.DEVICE_ID),
    device_name: nullableText(row.DEVICE_NAME),
    locator: locatorText(row.LOCATOR),
    created_date: isoDate(row.CREATED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

/** How far each reader is through each series, which the read-status filters of series ask. */
const readProgressSeries: Copy = {
  table: 'read_progress_series',
  from: 'READ_PROGRESS_SERIES',
  map: (row, { timestamp, zone }) => ({
    user_id: text(row.USER_ID),
    series_id: text(row.SERIES_ID),
    read_count: number(row.READ_COUNT, 0),
    in_progress_count: number(row.IN_PROGRESS_COUNT, 0),
    most_recent_read_date: nullableDate(row.MOST_RECENT_READ_DATE, timestamp, zone),
    most_recent_book_id: nullableText(row.MOST_RECENT_BOOK_ID),
    created_date: isoDate(row.CREATED_DATE ?? row.LAST_MODIFIED_DATE, timestamp, zone),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
  }),
}

const collections: Copy = {
  table: 'collections',
  from: 'COLLECTION',
  map: () => null,
  prepare: ({ legacy }) => {
    const counts = countsBy(legacy, 'COLLECTION_SERIES', 'COLLECTION_ID')
    return (row, { timestamp, zone }) => ({
      id: text(row.ID),
      name: text(row.NAME),
      ordered: bool(row.ORDERED, 0),
      series_count: number(row.SERIES_COUNT, counts.get(text(row.ID)) ?? 0),
      created_date: isoDate(row.CREATED_DATE, timestamp, zone),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
    })
  },
}

const readLists: Copy = {
  table: 'readlists',
  from: 'READLIST',
  map: () => null,
  prepare: ({ legacy }) => {
    const counts = countsBy(legacy, 'READLIST_BOOK', 'READLIST_ID')
    return (row, { timestamp, zone }) => ({
      id: text(row.ID),
      name: text(row.NAME),
      summary: text(row.SUMMARY, ''),
      ordered: bool(row.ORDERED, 0),
      book_count: counts.get(text(row.ID)) ?? 0,
      created_date: isoDate(row.CREATED_DATE, timestamp, zone),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
    })
  },
}

const members = (table: keyof DB, from: string, owner: string, member: string): Copy => ({
  table,
  from,
  map: (row) => ({
    [owner]: text(row[owner.toUpperCase()]),
    [member]: text(row[member.toUpperCase()]),
    number: number(row.NUMBER, 0),
  }),
})

const keyValues = (table: keyof DB, from: string, withUser: boolean): Copy => ({
  table,
  from,
  map: (row) => ({
    ...(withUser ? { user_id: text(row.USER_ID) } : {}),
    key: text(row.KEY),
    value: text(row.VALUE),
  }),
})

/**
 * The hashes somebody has judged, one row per hash.
 *
 * Komga's own table is keyed by hash alone, but a database from before mid-2023 also
 * carried the media type in the key, so the same hash could appear more than once.
 * The first row wins - they describe the same image - and a hash with no action
 * recorded is treated as one that removes nothing.
 */
const pageHashes: Copy = {
  table: 'page_hash',
  from: 'PAGE_HASH',
  map: () => null,
  prepare: () => {
    const seen = new Set<string>()
    return (row, { timestamp, zone }) => {
      const hash = text(row.HASH)
      if (hash === '' || seen.has(hash)) return null
      seen.add(hash)
      return {
        hash,
        size: nullableNumber(row.SIZE),
        action: text(row.ACTION, 'IGNORE'),
        delete_count: number(row.DELETE_COUNT, 0),
        created_date: isoDate(row.CREATED_DATE, timestamp, zone),
        last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp, zone),
      }
    }
  },
}

/** The image of a known duplicate, one per hash, as the table is keyed now. */
const pageHashThumbnails: Copy = {
  table: 'page_hash_thumbnail',
  from: 'PAGE_HASH_THUMBNAIL',
  map: () => null,
  prepare: () => {
    const seen = new Set<string>()
    return (row) => {
      const hash = text(row.HASH)
      if (hash === '' || !row.THUMBNAIL || seen.has(hash)) return null
      seen.add(hash)
      return { hash, thumbnail: row.THUMBNAIL }
    }
  },
}

/** In normal mode, in an order where everything a row points at is already there. */
const CORE: Copy[] = [
  libraryCopy(),
  libraryExclusions,
  users,
  apiKeys,
  userSharing,
  pair('user_library_sharing', 'USER_LIBRARY_SHARING', [
    ['user_id', 'USER_ID'],
    ['library_id', 'LIBRARY_ID'],
  ]),
  series,
  seriesMetadata,
  authors('series_metadata_author', 'SERIES_METADATA_AUTHOR', 'series_id'),
  pair('series_metadata_tag', 'SERIES_METADATA_TAG', [
    ['series_id', 'SERIES_ID'],
    ['tag', 'TAG'],
  ]),
  pair('series_metadata_genre', 'SERIES_METADATA_GENRE', [
    ['series_id', 'SERIES_ID'],
    ['genre', 'GENRE'],
  ]),
  links('series_metadata_link', 'SERIES_METADATA_LINK', 'series_id'),
  {
    table: 'series_metadata_alternate_title',
    from: 'SERIES_METADATA_ALTERNATE_TITLE',
    map: (row) =>
      text(row.SERIES_ID) === '' || text(row.TITLE) === ''
        ? null
        : { series_id: text(row.SERIES_ID), title: text(row.TITLE), label: text(row.LABEL) },
  },
  pair('series_metadata_sharing', 'SERIES_METADATA_SHARING', [
    ['series_id', 'SERIES_ID'],
    ['label', 'LABEL'],
  ]),
  books,
  bookMetadata,
  authors('book_metadata_author', 'BOOK_METADATA_AUTHOR', 'book_id'),
  pair('book_metadata_tag', 'BOOK_METADATA_TAG', [
    ['book_id', 'BOOK_ID'],
    ['tag', 'TAG'],
  ]),
  links('book_metadata_link', 'BOOK_METADATA_LINK', 'book_id'),
  aggregation,
  authors('book_metadata_aggregation_author', 'BOOK_METADATA_AGGREGATION_AUTHOR', 'series_id'),
  pair('book_metadata_aggregation_tag', 'BOOK_METADATA_AGGREGATION_TAG', [
    ['series_id', 'SERIES_ID'],
    ['tag', 'TAG'],
  ]),
  media,
  mediaPages,
  mediaFiles,
  thumbnails('THUMBNAIL_BOOK', 'BOOK', 'BOOK_ID'),
  thumbnails('THUMBNAIL_SERIES', 'SERIES', 'SERIES_ID'),
  thumbnails('THUMBNAIL_COLLECTION', 'COLLECTION', 'COLLECTION_ID'),
  thumbnails('THUMBNAIL_READLIST', 'READLIST', 'READLIST_ID'),
  readProgress,
  readProgressSeries,
  collections,
  members('collection_series', 'COLLECTION_SERIES', 'collection_id', 'series_id'),
  readLists,
  members('readlist_book', 'READLIST_BOOK', 'readlist_id', 'book_id'),
  keyValues('server_settings', 'SERVER_SETTINGS', false),
  {
    table: 'client_settings_global',
    from: 'CLIENT_SETTINGS_GLOBAL',
    // Whether a setting may be read before signing in, as the login page needs some.
    map: (row) => ({ key: text(row.KEY), value: text(row.VALUE), allow_unauthorized: bool(row.ALLOW_UNAUTHORIZED, 0) }),
  },
  keyValues('client_settings_user', 'CLIENT_SETTINGS_USER', true),
  pageHashes,
  pageHashThumbnails,
]

/** With `--rescan-only`: who may sign in, and where the libraries are; the content is scanned afresh. */
const RESCAN_ONLY = new Set<keyof DB>([
  'libraries',
  'library_exclusions',
  'users',
  'user_library_sharing',
  'server_settings',
])

/** What Komga has that is not carried over, and why, said when there is some. */
const NOT_CARRIED: [string, string][] = [
  ['HISTORICAL_EVENT', 'the history of scans and deletions'],
  ['AUTHENTICATION_ACTIVITY', 'the record of sign-ins'],
  ['ANNOUNCEMENTS_READ', 'which announcements were read'],
  ['SIDECAR', 'the record of files beside books; the first scan finds them again'],
  ['SYNC_POINT', 'Kobo sync points'],
]

// -------------------------------------------------------------------- import

/** Child-first table order used when clearing a destination for `--force`. */
const CLEAR_ORDER: (keyof DB)[] = [
  'page_hash_thumbnail',
  'page_hash',
  'announcements_read',
  'sync_point_readlist',
  'sync_point_book',
  'sync_points',
  'client_settings_user',
  'client_settings_global',
  'server_settings',
  'jobs',
  'historical_events',
  'readlist_request',
  'readlist_book',
  'readlists',
  'collection_series',
  'collections',
  'read_progress_series',
  'read_progress',
  'thumbnails',
  'epub_positions',
  'epub_toc',
  'media_container',
  'media_file',
  'media_page',
  'media',
  'book_metadata_aggregation_tag',
  'book_metadata_aggregation_author',
  'book_metadata_aggregation',
  'book_metadata_link',
  'book_metadata_tag',
  'book_metadata_author',
  'book_metadata',
  'books',
  'sidecars',
  'series_metadata_sharing',
  'series_metadata_alternate_title',
  'series_metadata_link',
  'series_metadata_genre',
  'series_metadata_tag',
  'series_metadata_author',
  'series_metadata',
  'series',
  'library_exclusions',
  'user_library_sharing',
  'user_sharing',
  'user_api_keys',
  'authentication_activity',
  'sessions',
  'users',
  'libraries',
]

async function clearDestination(db: Kysely<DB>): Promise<void> {
  for (const table of CLEAR_ORDER) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.deleteFrom(table as any).execute()
  }
}

/** Writes rows one prepared statement per table and set of columns; with none, only counts them. */
class Writer {
  private readonly statements = new Map<string, BetterSqlite3.Statement>()

  constructor(private readonly sqlite: BetterSqlite3.Database | null) {}

  write(table: string, row: Row): void {
    if (this.sqlite === null) return
    const columns = Object.keys(row)
    const key = `${table}\u0000${columns.join(',')}`
    let statement = this.statements.get(key)
    if (statement === undefined) {
      statement = this.sqlite.prepare(
        `insert into "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
      )
      this.statements.set(key, statement)
    }
    statement.run(...columns.map((column) => (row[column] === undefined ? null : row[column])))
  }
}

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`
const thousands = (value: number) => value.toLocaleString('en-US')

/** Look for each book's file where the import put it. */
function checkBookFiles(
  paths: { libraryId: string; path: string; modified: string }[],
  libraries: readonly LibraryPlacement[],
  progress: (line: string) => void,
): MissingFiles {
  const names = new Map(libraries.map((library) => [library.id, library.name]))
  const byLibrary = new Map<string, number>()
  const examples: string[] = []
  let missing = 0
  let timesMatching = 0
  const differences = new Map<number, number>()
  for (const [index, entry] of paths.entries()) {
    const onDisk = fileTime(entry.path)
    if (onDisk === null) {
      missing += 1
      if (examples.length < 10) examples.push(entry.path)
      byLibrary.set(entry.libraryId, (byLibrary.get(entry.libraryId) ?? 0) + 1)
    } else if (onDisk === entry.modified) {
      timesMatching += 1
    } else {
      // To the nearest quarter hour, which is as fine as any zone's offset goes.
      const hours = Math.round(((Date.parse(entry.modified) - Date.parse(onDisk)) / 3_600_000) * 4) / 4
      differences.set(hours, (differences.get(hours) ?? 0) + 1)
    }
    if ((index + 1) % 50_000 === 0) progress(`  checked ${thousands(index + 1)} of ${thousands(paths.length)} files`)
  }
  return {
    checked: paths.length,
    missing,
    timesMatching,
    timeDifferences: [...differences.entries()]
      .map(([hours, files]) => ({ hours, files }))
      .sort((left, right) => right.files - left.files)
      .slice(0, 5),
    examples,
    byLibrary: [...byLibrary.entries()]
      .map(([id, count]) => ({ library: names.get(id) ?? id, missing: count }))
      .sort((left, right) => right.missing - left.missing),
  }
}

/**
 * Migrate a legacy Komga config directory into the MangaLibrary schema.
 *
 * The legacy database is only ever opened read-only. Everything is written in one
 * transaction: an import that fails part-way leaves the destination as it was.
 */
export async function importKomga(options: ImportOptions): Promise<ImportReport> {
  const from = resolve(options.from)
  const to = resolve(options.to)
  const progress = options.progress ?? (() => {})
  const legacy = new LegacyDatabase(join(from, 'database.sqlite'))

  try {
    const targetFile = options.dryRun ? ':memory:' : join(to, 'database.sqlite')
    if (!options.dryRun) mkdirSync(dirname(targetFile), { recursive: true })

    let database: Database | undefined
    try {
      database = createDatabase(targetFile)
      const { applied } = await migrate(database.db, migrations)

      const existing = await database.db.selectFrom('users').select('id').execute()
      const existingLibraries = await database.db.selectFrom('libraries').select('id').execute()
      if (!options.dryRun && existing.length + existingLibraries.length > 0 && !options.force) {
        throw new Error(
          `Destination "${to}" already contains data (${existing.length} users, ${existingLibraries.length} libraries). Pass --force after backing up.`,
        )
      }

      const zone = options.timezone ?? localZone()
      const context: Context = {
        legacy,
        relocator: new Relocator(options.map ?? []),
        timestamp: new Date().toISOString(),
        zone,
        bookPaths: options.checkFiles ? [] : null,
      }
      const writer = new Writer(options.dryRun ? null : database.sqlite)
      const counts: TableCount[] = []

      // Writing many rows a statement at a time is only fast inside one transaction,
      // and one transaction is also what makes a failure leave nothing behind.
      if (!options.dryRun) database.sqlite.exec('begin')
      try {
        if (!options.dryRun && options.force) await clearDestination(database.db)

        for (const copy of CORE) {
          if (options.rescanOnly && !RESCAN_ONLY.has(copy.table)) continue
          const total = legacy.count(copy.from)
          if (total === 0) continue
          const started = performance.now()
          const map = copy.prepare ? copy.prepare(context) : copy.map
          let rows = 0
          let read = 0
          for (const legacyRow of legacy.iterate(copy.from)) {
            read += 1
            const row = map(legacyRow, context)
            if (row !== null) {
              try {
                writer.write(copy.table, row)
              } catch (error) {
                throw new Error(
                  `${copy.table}: ${(error as Error).message} (row ${JSON.stringify(legacyRow).slice(0, 300)})`,
                  { cause: error },
                )
              }
              rows += 1
            }
            if (read % 1_000_000 === 0) progress(`  ${copy.table}: ${thousands(read)} of ${thousands(total)}...`)
          }
          const existingCount = counts.find((entry) => entry.table === copy.table)
          if (existingCount) existingCount.rows += rows
          else counts.push({ table: copy.table, rows })
          progress(
            `  ${copy.table.padEnd(34)} ${thousands(rows).padStart(11)}  (${seconds(performance.now() - started)})`,
          )
        }
        if (!options.dryRun) database.sqlite.exec('commit')
      } catch (error) {
        if (!options.dryRun) database.sqlite.exec('rollback')
        throw error
      }

      const libraries = [...context.relocator.placements()].sort((left, right) => left.name.localeCompare(right.name))
      const warnings: string[] = []
      if (options.rescanOnly) {
        warnings.push(
          'Rescan-only mode: series, books, metadata overrides, thumbnails and read progress were NOT imported. ' +
            'Scan the libraries after starting the server.',
        )
      }
      const lost = libraries.filter((library) => !library.found)
      if (lost.length > 0) {
        warnings.push(
          `${lost.length} of ${libraries.length} libraries have no folder at their new root: ` +
            lost.map((library) => `${library.name} (${library.root})`).join(', ') +
            '. Give --map for where they are now, or a scan will find them empty.',
        )
      }
      for (const [table, what] of NOT_CARRIED) {
        const rows = legacy.count(table)
        if (rows > 0) warnings.push(`Not carried over: ${what} (${thousands(rows)} rows of ${table}).`)
      }

      let missingFiles: MissingFiles | null = null
      if (context.bookPaths !== null) {
        progress(`Looking for ${thousands(context.bookPaths.length)} book files...`)
        missingFiles = checkBookFiles(context.bookPaths, libraries, progress)
      }

      return {
        from,
        to,
        dryRun: options.dryRun === true,
        migrations: applied,
        tables: counts.filter((entry) => entry.rows > 0),
        totalRows: counts.reduce((sum, entry) => sum + entry.rows, 0),
        libraries,
        timezone: zone,
        missingFiles,
        warnings,
      }
    } finally {
      await database?.close()
    }
  } finally {
    legacy.close()
  }
}

/** Human-readable summary of an import run. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = []
  lines.push(`Source:      ${report.from}`)
  lines.push(`Destination: ${report.to}${report.dryRun ? ' (dry run, nothing written)' : ''}`)
  lines.push('')
  lines.push('Table                                     Rows')
  for (const entry of report.tables) lines.push(`${entry.table.padEnd(34)} ${thousands(entry.rows).padStart(11)}`)
  lines.push(`${'TOTAL'.padEnd(34)} ${thousands(report.totalRows).padStart(11)}`)
  if (report.libraries.length > 0) {
    lines.push('', 'Libraries')
    for (const library of report.libraries) {
      lines.push(`  ${library.found ? '   ' : 'NOT'} ${library.name}: ${library.komga} -> ${library.root}`)
    }
  }
  if (report.missingFiles !== null) {
    const missing = report.missingFiles
    const found = missing.checked - missing.missing
    lines.push('', `Book files: ${thousands(found)} of ${thousands(missing.checked)} found.`)
    lines.push(
      `  with the modification time Komga recorded (read in ${report.timezone}): ${thousands(missing.timesMatching)} of ${thousands(found)}`,
    )
    for (const entry of missing.timeDifferences) {
      lines.push(`  ${thousands(entry.files)} differ by ${entry.hours > 0 ? '+' : ''}${entry.hours} h`)
    }
    if (found > 0 && missing.timesMatching < found / 2) {
      lines.push(
        '  Most times differ: if by a whole number of hours, Komga ran in another time zone - give it with --timezone.',
        '  A scan reads a book whose time differs as changed, and reads it again.',
      )
    }
    for (const entry of missing.byLibrary) lines.push(`  missing in ${entry.library}: ${thousands(entry.missing)}`)
    for (const example of missing.examples) lines.push(`  e.g. ${example}`)
  }
  for (const warning of report.warnings) lines.push('', `WARNING: ${warning}`)
  return lines.join('\n')
}
