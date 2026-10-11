import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'

/**
 * Partial metadata updates, as described by the spec: "Set a field to null to
 * unset the metadata. You can omit fields you don't want to update."
 *
 * A per-field lock does not block a PATCH - locks exist so that scanning and
 * metadata refresh leave a hand-edited field alone, which is the scanner's job
 * (M6). PATCH records the requested value *and* the requested lock state, so a
 * client can lock a field in the same call that sets it.
 *
 * Non-nullable columns (`title`, `summary`, ...) cannot be unset, so an explicit
 * null for them is ignored rather than stored as an empty string.
 */

export const SERIES_STATUSES = ['ONGOING', 'ENDED', 'ABANDONED', 'HIATUS'] as const
export const READING_DIRECTIONS = ['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT', 'VERTICAL', 'WEBTOON'] as const

export type ValidationErrors = Record<string, string>
export type PatchResult = { ok: true } | { ok: false; errors: ValidationErrors }

type FieldKind = 'string' | 'nullable-string' | 'int' | 'nullable-int' | 'bool' | 'enum'

interface FieldSpec {
  /** Field name in the update DTO. */
  api: string
  column: string
  kind: FieldKind
  values?: readonly string[]
}

type SeriesListTable =
  | 'series_metadata_sharing'
  | 'series_metadata_tag'
  | 'series_metadata_genre'
  | 'series_metadata_link'
  | 'series_metadata_alternate_title'

type BookListTable = 'book_metadata_author' | 'book_metadata_tag' | 'book_metadata_link'

type ListTable = SeriesListTable | BookListTable

interface ListSpec {
  /** Field name in the update DTO. */
  api: string
  /** Lock column set when the list is present. */
  lockColumn: string
  lockApi: string
  table: ListTable
  /** Build a row for the child table, or null when the entry is unusable. */
  row: (id: string, entry: unknown) => Record<string, unknown> | null
}

const string = (api: string, column: string): FieldSpec => ({ api, column, kind: 'string' })
const nullableString = (api: string, column: string): FieldSpec => ({ api, column, kind: 'nullable-string' })
const nullableInt = (api: string, column: string): FieldSpec => ({ api, column, kind: 'nullable-int' })
const bool = (api: string, column: string): FieldSpec => ({ api, column, kind: 'bool' })
const enumeration = (api: string, column: string, values: readonly string[]): FieldSpec => ({
  api,
  column,
  kind: 'enum',
  values,
})

const SERIES_FIELDS: FieldSpec[] = [
  enumeration('status', 'status', SERIES_STATUSES),
  bool('statusLock', 'status_lock'),
  string('title', 'title'),
  bool('titleLock', 'title_lock'),
  string('titleSort', 'title_sort'),
  bool('titleSortLock', 'title_sort_lock'),
  string('publisher', 'publisher'),
  bool('publisherLock', 'publisher_lock'),
  string('language', 'language'),
  bool('languageLock', 'language_lock'),
  nullableInt('ageRating', 'age_rating'),
  bool('ageRatingLock', 'age_rating_lock'),
  enumeration('readingDirection', 'reading_direction', READING_DIRECTIONS),
  bool('readingDirectionLock', 'reading_direction_lock'),
  string('summary', 'summary'),
  bool('summaryLock', 'summary_lock'),
  nullableInt('totalBookCount', 'total_book_count'),
  bool('totalBookCountLock', 'total_book_count_lock'),
]

const BOOK_FIELDS: FieldSpec[] = [
  string('title', 'title'),
  bool('titleLock', 'title_lock'),
  string('summary', 'summary'),
  bool('summaryLock', 'summary_lock'),
  string('number', 'number'),
  bool('numberLock', 'number_lock'),
  { api: 'numberSort', column: 'number_sort', kind: 'int' },
  bool('numberSortLock', 'number_sort_lock'),
  nullableString('releaseDate', 'release_date'),
  bool('releaseDateLock', 'release_date_lock'),
  string('isbn', 'isbn'),
  bool('isbnLock', 'isbn_lock'),
]

/** `{ [idColumn]: id, [column]: text }` for one entry, or null when it is blank. */
function stringRow(id: string, idColumn: string, entry: unknown, column: string): Record<string, unknown> | null {
  const text = typeof entry === 'string' ? entry.trim() : ''
  return text === '' ? null : { [idColumn]: id, [column]: text }
}

/** Read a named string property from an unknown value, without trusting its shape. */
function textAt(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

const SERIES_LISTS: ListSpec[] = [
  {
    api: 'sharingLabels',
    lockColumn: 'sharing_labels_lock',
    lockApi: 'sharingLabelsLock',
    table: 'series_metadata_sharing',
    row: (id, entry) => stringRow(id, 'series_id', entry, 'label'),
  },
  {
    api: 'tags',
    lockColumn: 'tags_lock',
    lockApi: 'tagsLock',
    table: 'series_metadata_tag',
    row: (id, entry) => stringRow(id, 'series_id', entry, 'tag'),
  },
  {
    api: 'genres',
    lockColumn: 'genres_lock',
    lockApi: 'genresLock',
    table: 'series_metadata_genre',
    row: (id, entry) => stringRow(id, 'series_id', entry, 'genre'),
  },
  {
    api: 'links',
    lockColumn: 'links_lock',
    lockApi: 'linksLock',
    table: 'series_metadata_link',
    row: (id, entry) => {
      const label = textAt(entry, 'label')
      const url = textAt(entry, 'url')
      return url === '' ? null : { series_id: id, label, url }
    },
  },
  {
    api: 'alternateTitles',
    lockColumn: 'alternate_titles_lock',
    lockApi: 'alternateTitlesLock',
    table: 'series_metadata_alternate_title',
    row: (id, entry) => {
      const label = textAt(entry, 'label')
      const title = textAt(entry, 'title')
      return title === '' ? null : { series_id: id, label, title }
    },
  },
]

const BOOK_LISTS: ListSpec[] = [
  {
    api: 'authors',
    lockColumn: 'authors_lock',
    lockApi: 'authorsLock',
    table: 'book_metadata_author',
    row: (id, entry) => {
      const name = textAt(entry, 'name')
      const role = textAt(entry, 'role')
      return name === '' ? null : { book_id: id, name, role }
    },
  },
  {
    api: 'tags',
    lockColumn: 'tags_lock',
    lockApi: 'tagsLock',
    table: 'book_metadata_tag',
    row: (id, entry) => stringRow(id, 'book_id', entry, 'tag'),
  },
  {
    api: 'links',
    lockColumn: 'links_lock',
    lockApi: 'linksLock',
    table: 'book_metadata_link',
    row: (id, entry) => {
      const label = textAt(entry, 'label')
      const url = textAt(entry, 'url')
      return url === '' ? null : { book_id: id, label, url }
    },
  },
]

interface ScalarResult {
  values: Record<string, unknown>
  errors: ValidationErrors
}

function scalarValues(fields: readonly FieldSpec[], body: Record<string, unknown>): ScalarResult {
  const values: Record<string, unknown> = {}
  const errors: ValidationErrors = {}

  for (const spec of fields) {
    if (!(spec.api in body)) continue
    const value = body[spec.api]

    switch (spec.kind) {
      case 'bool':
        if (typeof value !== 'boolean') errors[spec.api] = 'must be a boolean'
        else values[spec.column] = value ? 1 : 0
        break
      case 'int':
      case 'nullable-int': {
        if (value === null && spec.kind === 'nullable-int') {
          values[spec.column] = null
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          values[spec.column] = Math.trunc(value)
        } else {
          errors[spec.api] = 'must be an integer'
        }
        break
      }
      case 'nullable-string':
        if (value === null) values[spec.column] = null
        else if (typeof value === 'string') values[spec.column] = value
        else errors[spec.api] = 'must be a string or null'
        break
      case 'enum':
        if (value === null) break
        if (typeof value === 'string' && spec.values?.includes(value)) values[spec.column] = value
        else errors[spec.api] = `must be one of ${(spec.values ?? []).join(', ')}`
        break
      case 'string':
        // Cannot unset a non-nullable column.
        if (value === null) break
        if (typeof value === 'string') values[spec.column] = value
        else errors[spec.api] = 'must be a string'
        break
    }
  }

  return { values, errors }
}

interface ListResult {
  /** Rows to insert, keyed by table. */
  inserts: Map<ListTable, Record<string, unknown>[]>
  /** Lock column updates. */
  lockValues: Record<string, unknown>
  errors: ValidationErrors
}

function listValues(id: string, specs: readonly ListSpec[], body: Record<string, unknown>): ListResult {
  const inserts = new Map<ListTable, Record<string, unknown>[]>()
  const lockValues: Record<string, unknown> = {}
  const errors: ValidationErrors = {}

  for (const spec of specs) {
    if (spec.lockApi in body) {
      const value = body[spec.lockApi]
      if (typeof value !== 'boolean') errors[spec.lockApi] = 'must be a boolean'
      else lockValues[spec.lockColumn] = value ? 1 : 0
    }
    if (!(spec.api in body)) continue

    const value = body[spec.api]
    if (!Array.isArray(value)) {
      errors[spec.api] = 'must be an array'
      continue
    }
    const rows: Record<string, unknown>[] = []
    for (const entry of value) {
      const row = spec.row(id, entry)
      if (row) rows.push(row)
    }
    inserts.set(spec.table, rows)
  }

  return { inserts, lockValues, errors }
}

/**
 * Replace every row of a child table for one parent.
 *
 * The table name stays a literal in each branch, so a typo cannot reach the
 * database, and the id column always matches the table it is used with.
 */
async function replaceRows(
  db: Kysely<DB>,
  table: ListTable,
  id: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  switch (table) {
    case 'series_metadata_sharing':
      await db.deleteFrom('series_metadata_sharing').where('series_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('series_metadata_sharing').values(rows as never).execute()
      return
    case 'series_metadata_tag':
      await db.deleteFrom('series_metadata_tag').where('series_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('series_metadata_tag').values(rows as never).execute()
      return
    case 'series_metadata_genre':
      await db.deleteFrom('series_metadata_genre').where('series_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('series_metadata_genre').values(rows as never).execute()
      return
    case 'series_metadata_link':
      await db.deleteFrom('series_metadata_link').where('series_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('series_metadata_link').values(rows as never).execute()
      return
    case 'series_metadata_alternate_title':
      await db.deleteFrom('series_metadata_alternate_title').where('series_id', '=', id).execute()
      if (rows.length > 0) {
        await db.insertInto('series_metadata_alternate_title').values(rows as never).execute()
      }
      return
    case 'book_metadata_author':
      await db.deleteFrom('book_metadata_author').where('book_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('book_metadata_author').values(rows as never).execute()
      return
    case 'book_metadata_tag':
      await db.deleteFrom('book_metadata_tag').where('book_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('book_metadata_tag').values(rows as never).execute()
      return
    case 'book_metadata_link':
      await db.deleteFrom('book_metadata_link').where('book_id', '=', id).execute()
      if (rows.length > 0) await db.insertInto('book_metadata_link').values(rows as never).execute()
      return
  }
}

async function applyPatch(
  db: Kysely<DB>,
  table: 'series_metadata' | 'book_metadata',
  id: string,
  fields: readonly FieldSpec[],
  lists: readonly ListSpec[],
  body: Record<string, unknown>,
): Promise<PatchResult> {
  const scalars = scalarValues(fields, body)
  const list = listValues(id, lists, body)
  const errors = { ...scalars.errors, ...list.errors }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const values = { ...scalars.values, ...list.lockValues }
  const hasScalarChange = Object.keys(values).length > 0
  const hasListChange = list.inserts.size > 0
  if (!hasScalarChange && !hasListChange) return { ok: true }

  values.last_modified_date = new Date().toISOString()

  if (table === 'series_metadata') {
    await db
      .updateTable('series_metadata')
      .set(values as never)
      .where('series_id', '=', id)
      .execute()
  } else {
    await db
      .updateTable('book_metadata')
      .set(values as never)
      .where('book_id', '=', id)
      .execute()
  }

  for (const [childTable, rows] of list.inserts) {
    await replaceRows(db, childTable, id, rows)
  }

  return { ok: true }
}

export async function applySeriesMetadataPatch(
  db: Kysely<DB>,
  seriesId: string,
  body: Record<string, unknown>,
): Promise<PatchResult> {
  return applyPatch(db, 'series_metadata', seriesId, SERIES_FIELDS, SERIES_LISTS, body)
}

export async function applyBookMetadataPatch(
  db: Kysely<DB>,
  bookId: string,
  body: Record<string, unknown>,
): Promise<PatchResult> {
  return applyPatch(db, 'book_metadata', bookId, BOOK_FIELDS, BOOK_LISTS, body)
}
