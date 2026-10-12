import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Kysely } from 'kysely'
import type { Database } from '../../server/src/db/index.js'
import { createDatabase } from '../../server/src/db/index.js'
import { migrate } from '../../server/src/db/migrate.js'
import { migrations } from '../../server/src/db/migrations/index.js'
import type { DB } from '../../server/src/db/schema.js'
import { LegacyDatabase } from './legacy.js'

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
}

export interface TableCount {
  table: string
  rows: number
}

export interface ImportReport {
  from: string
  to: string
  dryRun: boolean
  migrations: string[]
  tables: TableCount[]
  totalRows: number
  warnings: string[]
}

const CHUNK = 200

/** Tables copied in normal mode, in foreign-key-safe order. */
const CORE_TABLES = [
  'libraries',
  'library_exclusions',
  'users',
  'user_sharing',
  'user_library_sharing',
  'series',
  'series_metadata',
  'series_metadata_author',
  'series_metadata_tag',
  'series_metadata_genre',
  'series_metadata_link',
  'books',
  'book_metadata',
  'book_metadata_author',
  'book_metadata_tag',
  'book_metadata_link',
  'media',
  'media_page',
  'thumbnails',
  'read_progress',
  'collections',
  'collection_series',
  'readlists',
  'readlist_book',
  'server_settings',
  'client_settings_global',
  'client_settings_user',
  'page_hash',
  'page_hash_thumbnail',
] as const

/** Tables copied with `--rescan-only`: identity and settings, no content. */
const RESCAN_TABLES = ['libraries', 'library_exclusions', 'users', 'user_library_sharing', 'server_settings'] as const

// ------------------------------------------------------------------ helpers

const now = () => new Date().toISOString()

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

/** Legacy dates are `YYYY-MM-DD HH:MM:SS` in UTC; normalise to ISO-8601. */
function isoDate(value: unknown, fallback: string): string {
  const raw = nullableText(value)
  if (!raw) return fallback
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return `${raw.replace(' ', 'T')}Z`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function jsonArray(values: unknown[]): string {
  return JSON.stringify(values.filter((value) => value !== null && value !== undefined).map((value) => String(value)))
}

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function insertAll(db: Kysely<DB>, table: keyof DB, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0
  // The table and its rows are dynamic here: every mapper produces a plain
  // record keyed by column name, which Kysely cannot check statically.
  const insert = (group: Record<string, unknown>[]) =>
    db
      .insertInto(table as never)
      .values(group as never)
      .execute()

  for (const group of chunk(rows)) {
    await insert(group)
  }
  return rows.length
}

// ------------------------------------------------------------------ mappers

function mapLibraries(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('LIBRARY').map((row) => ({
    id: text(row.ID),
    name: text(row.NAME),
    root: text(row.ROOT),
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
    scan_on_startup: bool(row.SCAN_ON_STARTUP, 0),
    scan_interval: text(row.SCAN_INTERVAL, 'EVERY_6H'),
    scan_cbx: bool(row.SCAN_CBX, 1),
    scan_pdf: bool(row.SCAN_PDF, 1),
    scan_epub: bool(row.SCAN_EPUB, 1),
    scan_directory_exclusions: '[]',
    repair_extensions: bool(row.REPAIR_EXTENSIONS, 0),
    convert_to_cbz: bool(row.CONVERT_TO_CBZ, 0),
    empty_trash_after_scan: bool(row.EMPTY_TRASH_AFTER_SCAN, 0),
    series_cover: text(row.SERIES_COVER, 'FIRST'),
    hash_files: bool(row.HASH_FILES, 1),
    hash_pages: bool(row.HASH_PAGES, 0),
    hash_koreader: bool(row.HASH_KOREADER, 0),
    analyze_dimensions: bool(row.ANALYZE_DIMENSIONS, 1),
    oneshots_directory: nullableText(row.ONESHOTS_DIRECTORY),
    unavailable_date: nullableText(row.UNAVAILABLE_DATE),
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapLibraryExclusions(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('LIBRARY_EXCLUSIONS')
    .map((row) => ({ library_id: text(row.LIBRARY_ID), exclusion: text(row.EXCLUSION) }))
    .filter((row) => row.library_id !== '' && row.exclusion !== '')
}

function mapUserSharing(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('USER_SHARING')
    .map((row) => ({ user_id: text(row.USER_ID), allow: bool(row.ALLOW, 1), label: text(row.LABEL) }))
    .filter((row) => row.user_id !== '' && row.label !== '')
}

function mapUsers(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const rolesByUser = new Map<string, string[]>()
  for (const row of legacy.rows('USER_ROLE')) {
    const userId = text(row.USER_ID)
    const role = text(row.ROLE)
    if (!userId || !role) continue
    const list = rolesByUser.get(userId) ?? []
    list.push(role)
    rolesByUser.set(userId, list)
  }

  return legacy.rows('USER').map((row) => {
    const id = text(row.ID)
    // Legacy role flags predate the USER_ROLE table.
    const inlineRoles: string[] = []
    if (bool(row.ROLE_ADMIN, 0)) inlineRoles.push('ADMIN')
    if (bool(row.ROLE_FILE_DOWNLOAD, 0)) inlineRoles.push('FILE_DOWNLOAD')
    if (bool(row.ROLE_PAGE_STREAMING, 0)) inlineRoles.push('PAGE_STREAMING')
    if (bool(row.ROLE_KOBO_SYNC, 0)) inlineRoles.push('KOBO_SYNC')
    if (bool(row.ROLE_KOREADER_SYNC, 0)) inlineRoles.push('KOREADER_SYNC')

    const roles = rolesByUser.get(id) ?? inlineRoles
    return {
      id,
      email: text(row.EMAIL),
      password: text(row.PASSWORD),
      roles: jsonArray(roles),
      shared_all_libraries: bool(row.SHARED_ALL_LIBRARIES, 1),
      age_restriction:
        row.AGE_RESTRICTION === null || row.AGE_RESTRICTION === undefined ? null : number(row.AGE_RESTRICTION),
      age_restriction_allow_only:
        row.AGE_RESTRICTION_ALLOW_ONLY === null || row.AGE_RESTRICTION_ALLOW_ONLY === undefined
          ? null
          : bool(row.AGE_RESTRICTION_ALLOW_ONLY, 1),
      created_date: isoDate(row.CREATED_DATE, timestamp),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
    }
  })
}

function mapUserLibrarySharing(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('USER_LIBRARY_SHARING')
    .map((row) => ({ user_id: text(row.USER_ID), library_id: text(row.LIBRARY_ID) }))
    .filter((row) => row.user_id !== '' && row.library_id !== '')
}

function mapSeries(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const counts = new Map<string, number>()
  for (const book of legacy.rows('BOOK')) {
    const seriesId = text(book.SERIES_ID)
    counts.set(seriesId, (counts.get(seriesId) ?? 0) + 1)
  }

  return legacy.rows('SERIES').map((row) => {
    const id = text(row.ID)
    return {
      id,
      library_id: text(row.LIBRARY_ID),
      name: text(row.NAME),
      url: text(row.URL),
      file_last_modified: isoDate(row.FILE_LAST_MODIFIED, timestamp),
      book_count: number(row.BOOK_COUNT, counts.get(id) ?? 0),
      oneshot: bool(row.ONESHOT, 0),
      deleted_date: nullableText(row.DELETED_DATE),
      created_date: isoDate(row.CREATED_DATE, timestamp),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
    }
  })
}

function mapSeriesMetadata(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('SERIES_METADATA').map((row) => ({
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
    age_rating: row.AGE_RATING === null || row.AGE_RATING === undefined ? null : number(row.AGE_RATING),
    age_rating_lock: bool(row.AGE_RATING_LOCK, 0),
    reading_direction: nullableText(row.READING_DIRECTION),
    reading_direction_lock: bool(row.READING_DIRECTION_LOCK, 0),
    summary: text(row.SUMMARY, ''),
    summary_lock: bool(row.SUMMARY_LOCK, 0),
    total_book_count:
      row.TOTAL_BOOK_COUNT === null || row.TOTAL_BOOK_COUNT === undefined ? null : number(row.TOTAL_BOOK_COUNT),
    total_book_count_lock: bool(row.TOTAL_BOOK_COUNT_LOCK, 0),
    sharing_labels_lock: bool(row.SHARING_LABELS_LOCK, 0),
    tags_lock: bool(row.TAGS_LOCK, 0),
    genres_lock: bool(row.GENRES_LOCK, 0),
    links_lock: bool(row.LINKS_LOCK, 0),
    alternate_titles_lock: bool(row.ALTERNATE_TITLES_LOCK, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapSimpleChild(
  legacy: LegacyDatabase,
  legacyTable: string,
  parentColumn: string,
  column: string,
  targetColumn: string,
): Record<string, unknown>[] {
  return legacy
    .rows(legacyTable)
    .map((row) => ({ [parentColumn]: text(row[parentColumn.toUpperCase()]), [targetColumn]: text(row[column]) }))
    .filter((row) => (row[parentColumn] as string) !== '' && (row[targetColumn] as string) !== '')
}

function mapLinks(
  legacy: LegacyDatabase,
  legacyTable: string,
  legacyParentColumn: string,
  parentColumn: string,
): Record<string, unknown>[] {
  return legacy
    .rows(legacyTable)
    .map((row) => ({
      [parentColumn]: text(row[legacyParentColumn.toUpperCase()]),
      label: text(row.LABEL),
      url: text(row.URL),
    }))
    .filter((row) => (row[parentColumn] as string) !== '' && (row.url as string) !== '')
}

function mapSeriesAuthors(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('SERIES_METADATA_AUTHOR')
    .map((row) => ({
      series_id: text(row.SERIES_ID),
      name: text(row.NAME),
      role: text(row.ROLE),
    }))
    .filter((row) => row.series_id !== '' && row.name !== '')
}

function mapBooks(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('BOOK').map((row) => ({
    id: text(row.ID),
    series_id: text(row.SERIES_ID),
    library_id: text(row.LIBRARY_ID),
    name: text(row.NAME),
    url: text(row.URL),
    file_last_modified: isoDate(row.FILE_LAST_MODIFIED, timestamp),
    file_size: number(row.FILE_SIZE, 0),
    file_hash: nullableText(row.FILE_HASH),
    file_hash_koreader: nullableText(row.FILE_HASH_KOREADER),
    number: number(row.NUMBER, 0),
    oneshot: bool(row.ONESHOT, 0),
    deleted_date: nullableText(row.DELETED_DATE),
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapBookMetadata(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('BOOK_METADATA').map((row) => ({
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
    age_rating: row.AGE_RATING === null || row.AGE_RATING === undefined ? null : number(row.AGE_RATING),
    age_rating_lock: bool(row.AGE_RATING_LOCK, 0),
    reading_direction: nullableText(row.READING_DIRECTION),
    reading_direction_lock: bool(row.READING_DIRECTION_LOCK, 0),
    authors_lock: bool(row.AUTHORS_LOCK, 0),
    tags_lock: bool(row.TAGS_LOCK, 0),
    links_lock: bool(row.LINKS_LOCK, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapBookAuthors(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('BOOK_METADATA_AUTHOR')
    .map((row) => ({ book_id: text(row.BOOK_ID), name: text(row.NAME), role: text(row.ROLE) }))
    .filter((row) => row.book_id !== '' && row.name !== '')
}

function mapMedia(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('MEDIA').map((row) => ({
    book_id: text(row.BOOK_ID),
    media_type: nullableText(row.MEDIA_TYPE),
    status: text(row.STATUS, 'UNKNOWN'),
    comment: nullableText(row.COMMENT),
    page_count: number(row.PAGE_COUNT, 0),
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapMediaPages(legacy: LegacyDatabase): Record<string, unknown>[] {
  // A page's hash lives with the page in Komga too, and the column arrived after the
  // table did.
  const hasHash = legacy.hasColumns('MEDIA_PAGE', 'FILE_HASH')

  return legacy.rows('MEDIA_PAGE').map((row) => ({
    book_id: text(row.BOOK_ID),
    number: number(row.NUMBER, 0),
    file_name: text(row.FILE_NAME),
    media_type: text(row.MEDIA_TYPE),
    width: row.WIDTH === null || row.WIDTH === undefined ? null : number(row.WIDTH),
    height: row.HEIGHT === null || row.HEIGHT === undefined ? null : number(row.HEIGHT),
    file_size: row.FILE_SIZE === null || row.FILE_SIZE === undefined ? null : number(row.FILE_SIZE),
    file_hash: hasHash ? text(row.FILE_HASH) : '',
  }))
}

function mapThumbnails(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const sources: [string, string, string][] = [
    ['THUMBNAIL_BOOK', 'BOOK', 'BOOK_ID'],
    ['THUMBNAIL_SERIES', 'SERIES', 'SERIES_ID'],
    ['THUMBNAIL_COLLECTION', 'COLLECTION', 'COLLECTION_ID'],
    ['THUMBNAIL_READLIST', 'READLIST', 'READLIST_ID'],
  ]

  for (const [table, ownerType, ownerColumn] of sources) {
    // Komga keeps a thumbnail as bytes or as the URL of a file it found beside the
    // book, and the column for the second one arrived later than the table.
    const hasUrl = legacy.hasColumns(table, 'URL')

    for (const row of legacy.rows(table)) {
      const blob = row.THUMBNAIL ?? null
      const url = hasUrl ? (row.URL ?? null) : null
      if (blob === null && url === null) continue

      out.push({
        id: text(row.ID),
        owner_type: ownerType,
        owner_id: text(row[ownerColumn]),
        type: text(row.TYPE, 'GENERATED'),
        page: number(row.PAGE, 0),
        selected: bool(row.SELECTED, 1),
        media_type: text(row.MEDIA_TYPE, 'image/jpeg'),
        width: number(row.WIDTH, 0),
        height: number(row.HEIGHT, 0),
        file_size: number(row.FILE_SIZE, blob === null ? 0 : ((blob as Buffer).length ?? 0)),
        thumbnail: blob,
        url,
        created_date: isoDate(row.CREATED_DATE, timestamp),
        last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
      })
    }
  }

  return out.filter((row) => (row.owner_id as string) !== '')
}

function mapReadProgress(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  return legacy.rows('READ_PROGRESS').map((row) => ({
    user_id: text(row.USER_ID),
    book_id: text(row.BOOK_ID),
    page: number(row.PAGE, 0),
    completed: bool(row.COMPLETED, 0),
    read_date: nullableText(row.READ_DATE) ? isoDate(row.READ_DATE, timestamp) : null,
    device_id: legacy.hasColumns('READ_PROGRESS', 'DEVICE_ID') ? nullableText(row.DEVICE_ID) : null,
    device_name: legacy.hasColumns('READ_PROGRESS', 'DEVICE_NAME') ? nullableText(row.DEVICE_NAME) : null,
    locator: legacy.hasColumns('READ_PROGRESS', 'LOCATOR') ? nullableText(row.LOCATOR) : null,
    created_date: isoDate(row.CREATED_DATE, timestamp),
    last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
  }))
}

function mapCollections(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const counts = new Map<string, number>()
  for (const row of legacy.rows('COLLECTION_SERIES')) {
    const id = text(row.COLLECTION_ID)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return legacy.rows('COLLECTION').map((row) => {
    const id = text(row.ID)
    return {
      id,
      name: text(row.NAME),
      ordered: bool(row.ORDERED, 0),
      series_count: number(row.SERIES_COUNT, counts.get(id) ?? 0),
      created_date: isoDate(row.CREATED_DATE, timestamp),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
    }
  })
}

function mapCollectionSeries(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy.rows('COLLECTION_SERIES').map((row) => ({
    collection_id: text(row.COLLECTION_ID),
    series_id: text(row.SERIES_ID),
    number: number(row.NUMBER, 0),
  }))
}

function mapReadLists(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const counts = new Map<string, number>()
  for (const row of legacy.rows('READLIST_BOOK')) {
    const id = text(row.READLIST_ID)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return legacy.rows('READLIST').map((row) => {
    const id = text(row.ID)
    return {
      id,
      name: text(row.NAME),
      summary: text(row.SUMMARY, ''),
      ordered: bool(row.ORDERED, 0),
      book_count: counts.get(id) ?? 0,
      created_date: isoDate(row.CREATED_DATE, timestamp),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
    }
  })
}

function mapReadListBooks(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy.rows('READLIST_BOOK').map((row) => ({
    readlist_id: text(row.READLIST_ID),
    book_id: text(row.BOOK_ID),
    number: number(row.NUMBER, 0),
  }))
}

function mapServerSettings(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy.rows('SERVER_SETTINGS').map((row) => ({ key: text(row.KEY), value: text(row.VALUE) }))
}

function mapClientSettings(legacy: LegacyDatabase, table: string, withUser: boolean): Record<string, unknown>[] {
  return legacy.rows(table).map((row) => ({
    ...(withUser ? { user_id: text(row.USER_ID) } : {}),
    key: text(row.KEY),
    value: text(row.VALUE),
  }))
}

/**
 * The hashes somebody has judged, one row per hash.
 *
 * Komga's own table is keyed by hash alone, but a database from before mid-2023 also
 * carried the media type in the key, so the same hash could appear more than once.
 * The first row wins - they describe the same image - and a hash with no action
 * recorded is treated as one that removes nothing.
 */
function mapPageHash(legacy: LegacyDatabase, timestamp: string): Record<string, unknown>[] {
  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []

  for (const row of legacy.rows('PAGE_HASH')) {
    const hash = text(row.HASH)
    if (hash === '' || seen.has(hash)) continue
    seen.add(hash)

    rows.push({
      hash,
      size: row.SIZE === null || row.SIZE === undefined ? null : number(row.SIZE),
      action: text(row.ACTION, 'IGNORE'),
      delete_count: number(row.DELETE_COUNT, 0),
      created_date: isoDate(row.CREATED_DATE, timestamp),
      last_modified_date: isoDate(row.LAST_MODIFIED_DATE, timestamp),
    })
  }
  return rows
}

/** The image of a known duplicate, one per hash, as the table is keyed now. */
function mapPageHashThumbnails(legacy: LegacyDatabase): Record<string, unknown>[] {
  if (!legacy.hasTable('PAGE_HASH_THUMBNAIL')) return []

  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []
  for (const row of legacy.rows('PAGE_HASH_THUMBNAIL')) {
    const hash = text(row.HASH)
    const blob = row.THUMBNAIL
    if (hash === '' || !blob || seen.has(hash)) continue
    seen.add(hash)
    rows.push({ hash, thumbnail: blob })
  }
  return rows
}

/** Column tidying for `series_metadata_sharing`, which lives in its own legacy table. */
function mapSeriesSharing(legacy: LegacyDatabase): Record<string, unknown>[] {
  return legacy
    .rows('SERIES_METADATA_SHARING')
    .map((row) => ({ series_id: text(row.SERIES_ID), label: text(row.LABEL) }))
    .filter((row) => row.series_id !== '' && row.label !== '')
}

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

async function copyTable(name: keyof DB, legacy: LegacyDatabase, db: Kysely<DB>, timestamp: string): Promise<number> {
  switch (name) {
    case 'libraries':
      return insertAll(db, name, mapLibraries(legacy, timestamp))
    case 'library_exclusions':
      return insertAll(db, name, mapLibraryExclusions(legacy))
    case 'users':
      return insertAll(db, name, mapUsers(legacy, timestamp))
    case 'user_sharing':
      return insertAll(db, name, mapUserSharing(legacy))
    case 'user_library_sharing':
      return insertAll(db, name, mapUserLibrarySharing(legacy))
    case 'series':
      return insertAll(db, name, mapSeries(legacy, timestamp))
    case 'series_metadata':
      return insertAll(db, name, mapSeriesMetadata(legacy, timestamp))
    case 'series_metadata_author':
      return insertAll(db, name, mapSeriesAuthors(legacy))
    case 'series_metadata_tag':
      return insertAll(db, name, mapSimpleChild(legacy, 'SERIES_METADATA_TAG', 'series_id', 'TAG', 'tag'))
    case 'series_metadata_genre':
      return insertAll(db, name, mapSimpleChild(legacy, 'SERIES_METADATA_GENRE', 'series_id', 'GENRE', 'genre'))
    case 'series_metadata_link':
      return insertAll(db, name, mapLinks(legacy, 'SERIES_METADATA_LINK', 'SERIES_ID', 'series_id'))
    case 'books':
      return insertAll(db, name, mapBooks(legacy, timestamp))
    case 'book_metadata':
      return insertAll(db, name, mapBookMetadata(legacy, timestamp))
    case 'book_metadata_author':
      return insertAll(db, name, mapBookAuthors(legacy))
    case 'book_metadata_tag':
      return insertAll(db, name, mapSimpleChild(legacy, 'BOOK_METADATA_TAG', 'book_id', 'TAG', 'tag'))
    case 'book_metadata_link':
      return insertAll(db, name, mapLinks(legacy, 'BOOK_METADATA_LINK', 'BOOK_ID', 'book_id'))
    case 'media':
      return insertAll(db, name, mapMedia(legacy, timestamp))
    case 'media_page':
      return insertAll(db, name, mapMediaPages(legacy))
    case 'thumbnails':
      return insertAll(db, name, mapThumbnails(legacy, timestamp))
    case 'read_progress':
      return insertAll(db, name, mapReadProgress(legacy, timestamp))
    case 'collections':
      return insertAll(db, name, mapCollections(legacy, timestamp))
    case 'collection_series':
      return insertAll(db, name, mapCollectionSeries(legacy))
    case 'readlists':
      return insertAll(db, name, mapReadLists(legacy, timestamp))
    case 'readlist_book':
      return insertAll(db, name, mapReadListBooks(legacy))
    case 'server_settings':
      return insertAll(db, name, mapServerSettings(legacy))
    case 'client_settings_global':
      return insertAll(db, name, mapClientSettings(legacy, 'CLIENT_SETTINGS_GLOBAL', false))
    case 'client_settings_user':
      return insertAll(db, name, mapClientSettings(legacy, 'CLIENT_SETTINGS_USER', true))
    case 'page_hash':
      return insertAll(db, name, mapPageHash(legacy, timestamp))
    case 'page_hash_thumbnail':
      return insertAll(db, name, mapPageHashThumbnails(legacy))
    default:
      return 0
  }
}

/**
 * Migrate a legacy Komga config directory into the MangaLibrary schema.
 *
 * The legacy database is only ever opened read-only.
 */
export async function importKomga(options: ImportOptions): Promise<ImportReport> {
  const from = resolve(options.from)
  const to = resolve(options.to)
  const legacyFile = join(from, 'database.sqlite')

  const warnings: string[] = []
  const legacy = new LegacyDatabase(legacyFile)

  try {
    const targetFile = options.dryRun ? ':memory:' : join(to, 'database.sqlite')
    if (!options.dryRun) mkdirSync(dirname(targetFile), { recursive: true })

    let database: Database | undefined
    try {
      database = createDatabase(targetFile)
      const { applied } = await migrate(database.db, migrations)

      const existing = await database.db.selectFrom('users').select('id').execute()
      if (!options.dryRun && existing.length > 0) {
        if (!options.force) {
          throw new Error(
            `Destination "${to}" already contains data (${existing.length} users). Pass --force after backing up.`,
          )
        }
        await clearDestination(database.db)
      }

      const tables = options.rescanOnly ? RESCAN_TABLES : CORE_TABLES
      const counts: TableCount[] = []
      for (const table of tables) {
        const rows = await copyTable(table, legacy, database.db, now())
        counts.push({ table, rows })
      }

      if (!options.rescanOnly) {
        const sharing = await insertAll(database.db, 'series_metadata_sharing', mapSeriesSharing(legacy))
        if (sharing > 0) counts.push({ table: 'series_metadata_sharing', rows: sharing })
      }

      if (options.rescanOnly) {
        warnings.push(
          'Rescan-only mode: series, books, metadata overrides, thumbnails and read progress were NOT imported. ' +
            'Scan the libraries after starting the server.',
        )
      }
      if (!legacy.hasColumns('THUMBNAIL_BOOK', 'THUMBNAIL')) {
        warnings.push('No legacy thumbnails found; covers will be regenerated on scan.')
      }

      return {
        from,
        to,
        dryRun: options.dryRun === true,
        migrations: applied,
        tables: counts.filter((entry) => entry.rows > 0),
        totalRows: counts.reduce((sum, entry) => sum + entry.rows, 0),
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
  if (report.migrations.length > 0) lines.push(`Migrations:  ${report.migrations.join(', ')}`)
  lines.push('')
  lines.push('Table                            Rows')
  for (const entry of report.tables) lines.push(`${entry.table.padEnd(32)} ${String(entry.rows).padStart(6)}`)
  lines.push(`${'TOTAL'.padEnd(32)} ${String(report.totalRows).padStart(6)}`)
  for (const warning of report.warnings) lines.push('', `WARNING: ${warning}`)
  return lines.join('\n')
}
