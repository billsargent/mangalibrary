import { sql, type Kysely, type SelectQueryBuilder } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/session.js'
import { allLibraryIds } from '../auth/users.js'
import type { DB } from '../db/schema.js'
import { contentContext, scopedLibraryIds, type ContentContext } from './context.js'
import { springPage, type SpringPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { booleanParam, paging, toArray } from './query.js'
import { groupOf } from './series.js'

/**
 * The lists a filter is picked from: every tag, genre, publisher, author and so on
 * that the caller could meet where they are looking.
 *
 * "Where they are looking" is the whole of it. A panel opened in one library offers
 * that library's values, one opened on a collection that collection's, and a reader
 * kept from some series by age or label is not offered what only those series have.
 * So each list is the distinct values of a table, for the series - or the books -
 * a request is about, and that is asked of the database as a subquery: a list of
 * ids would be one parameter for every series, and SQLite stops at 32,766.
 *
 * When a request is about everything there is, nothing is checked against it, and
 * the values are read straight off an index that starts with them (migration 0024):
 * that costs by how many tags there are and not by how many books have them.
 */

interface AuthorDto {
  name: string
  role: string
}

type Query = Record<string, unknown>
type Ids = SelectQueryBuilder<DB, never, { id: string }>

interface Scope {
  /** The series a request is about. */
  series: Ids
  /** Their books; or, asked by read list, the books on it. */
  books: Ids
  /** Whether that is every series and every book, so that nothing needs checking against it. */
  everything: boolean
  /** Whether it is narrowed below whole libraries: a collection, a series, a read list. */
  narrow: boolean
}

/** A list of ids as one parameter, however long it is. */
const idList = (ids: readonly string[]) => sql<string>`(select value from json_each(${JSON.stringify(ids)}))`

/**
 * The series and books a request is about, or `null` when that is none at all.
 *
 * A request narrows by one thing: the first of library, collection, series and read
 * list that it names, in that order, as the reference does.
 */
function scopeOf(db: Kysely<DB>, context: ContentContext, query: Query, libraryCount: number): Scope | null {
  const libraries = toArray(query.library_id)
  const collections = toArray(query.collection_id)
  const seriesIds = toArray(query.series_id)
  const readLists = toArray(query.readlist_id)

  const libraryIds = scopedLibraryIds(context, libraries)
  if (libraryIds.length === 0) return null

  const restricted = context.restrictedSeriesIds
  let series = db.selectFrom('series').select('series.id').where('series.library_id', 'in', libraryIds)
  if (restricted !== null) series = series.where('series.id', 'in', idList(restricted))

  let narrowed = false
  let listed: SelectQueryBuilder<DB, 'readlist_book', { book_id: string }> | null = null
  if (libraries.length > 0) {
    // Already narrowed, above.
  } else if (collections.length > 0) {
    narrowed = true
    series = series.where(
      'series.id',
      'in',
      db
        .selectFrom('collection_series')
        .select('collection_series.series_id')
        .where('collection_series.collection_id', 'in', collections),
    )
  } else if (seriesIds.length > 0) {
    narrowed = true
    series = series.where('series.id', 'in', seriesIds)
  } else if (readLists.length > 0) {
    narrowed = true
    listed = db
      .selectFrom('readlist_book')
      .select('readlist_book.book_id')
      .where('readlist_book.readlist_id', 'in', readLists)
  }

  // A book knows its library, so whole libraries of books are found without going
  // by way of their series - which, for a large library, halves the work.
  let books = db.selectFrom('books').select('books.id')
  books =
    restricted === null && !narrowed
      ? books.where('books.library_id', 'in', libraryIds)
      : books.where('books.series_id', 'in', series)
  if (listed !== null) {
    books = books.where('books.id', 'in', listed)
    series = series.where(
      'series.id',
      'in',
      db.selectFrom('books').select('books.series_id').where('books.id', 'in', listed),
    )
  }
  return {
    series: series as unknown as Ids,
    books: books as unknown as Ids,
    everything: restricted === null && !narrowed && libraryIds.length === libraryCount,
    narrow: narrowed,
  }
}

/** Where a list's values are kept: a table, the column, and whose rows they are. */
interface Source {
  table: string
  column: string
  of: 'series' | 'books'
  /**
   * For what is kept a row to a book, the same values kept a row to a series: what
   * analysis aggregates of each series' books (`metadata/aggregation.ts`). A
   * library's worth of these is about a tenth of the rows, and found by series, so a
   * list over whole libraries reads these; a series, a collection or a read list is
   * few books, and is read from them.
   */
  aggregate?: { table: string; column: string }
}

const SERIES_TAGS: Source = { table: 'series_metadata_tag', column: 'tag', of: 'series' }
const BOOK_TAGS: Source = {
  table: 'book_metadata_tag',
  column: 'tag',
  of: 'books',
  aggregate: { table: 'book_metadata_aggregation_tag', column: 'tag' },
}
const GENRES: Source = { table: 'series_metadata_genre', column: 'genre', of: 'series' }
const SHARING_LABELS: Source = { table: 'series_metadata_sharing', column: 'label', of: 'series' }
const PUBLISHERS: Source = { table: 'series_metadata', column: 'publisher', of: 'series' }
const LANGUAGES: Source = { table: 'series_metadata', column: 'language', of: 'series' }

/** Whether a value contains what is searched for, whatever the case of either. */
const matcher = (search: string | undefined): ((value: string) => boolean) => {
  if (!search) return () => true
  const wanted = search.toLowerCase()
  return (value) => value.toLowerCase().includes(wanted)
}

/**
 * The distinct values of the sources, in the scope, containing what is searched for.
 *
 * The searching is done here and not by the database: there are few distinct values
 * however many rows hold them, and asking the database to compare every row would
 * stop it from reading them off an index.
 */
async function valuesOf(
  db: Kysely<DB>,
  scope: Scope,
  sources: readonly Source[],
  search: string | undefined,
): Promise<string[]> {
  const matches = matcher(search)
  const seen = new Set<string>()
  for (const wanted of sources) {
    const source = byLibraries(wanted, scope)
    // The table and its columns are constants of this file, never a request's words.
    let query = db
      .selectFrom(source.table as 'series_metadata_tag')
      .select(sql<string | null>`${sql.ref(source.column)}`.as('value'))
      .distinct()
    if (!scope.everything) {
      query = query.where(sql.ref(source.of === 'series' ? 'series_id' : 'book_id'), 'in', scope[source.of])
    }
    for (const row of await query.execute()) {
      const value = row.value?.trim()
      if (value && matches(value)) seen.add(value)
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right))
}

/** Where to read a source from for this scope: a book source over whole libraries reads its per-series aggregate. */
function byLibraries(source: Source, scope: Scope): Source {
  if (source.of !== 'books' || source.aggregate === undefined || scope.everything || scope.narrow) return source
  return { table: source.aggregate.table, column: source.aggregate.column, of: 'series' }
}

/** Who made the books and series in the scope, by name and what they did. */
async function authorsOf(
  db: Kysely<DB>,
  scope: Scope,
  search: string | undefined,
  role: string | undefined,
): Promise<AuthorDto[]> {
  const matches = matcher(search)
  const unique = new Map<string, AuthorDto>()
  // A library's worth of books' authors is read from the per-series aggregate, as tags are.
  const bookAuthors = scope.everything || scope.narrow ? 'book_metadata_author' : 'book_metadata_aggregation_author'
  for (const of of ['series', 'books'] as const) {
    const table = of === 'series' ? 'series_metadata_author' : bookAuthors
    const owner = of === 'books' && table === 'book_metadata_author' ? 'book_id' : 'series_id'
    let query = db
      .selectFrom(table as 'series_metadata_author')
      .select(['role', 'name'])
      .distinct()
    if (role) query = query.where('role', '=', role)
    if (!scope.everything) query = query.where(sql.ref(owner), 'in', owner === 'book_id' ? scope.books : scope.series)
    for (const author of await query.execute()) {
      if (matches(author.name)) {
        unique.set(`${author.name}\u0000${author.role}`, { name: author.name, role: author.role })
      }
    }
  }
  return [...unique.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.role.localeCompare(right.role),
  )
}

const SERIES_ROLES: Source = { table: 'series_metadata_author', column: 'role', of: 'series' }
const BOOK_ROLES: Source = {
  table: 'book_metadata_author',
  column: 'role',
  of: 'books',
  aggregate: { table: 'book_metadata_aggregation_author', column: 'role' },
}

const distinct = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right))

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** Which tags a request means: a series' own, its books', or - unless it says - both. */
function tagSources(include: unknown): Source[] {
  const wanted = String(include ?? 'BOTH').toUpperCase()
  if (wanted === 'SERIES') return [SERIES_TAGS]
  if (wanted === 'BOOK') return [BOOK_TAGS]
  return [SERIES_TAGS, BOOK_TAGS]
}

/** Either a plain array (v1) or a Spring page (v2) of the part of it asked for. */
function paginated<T>(items: T[], query: Query, usePage: boolean): T[] | SpringPage<T> {
  if (!usePage) return items
  if (booleanParam(query.unpaged) === true) return springPage(items, 0, items.length, items.length)
  const { page, size } = paging(query)
  return springPage(items.slice(page * size, page * size + size), page, size, items.length)
}

/** One tag of the cloud: its name, the letter it is listed under, and how many series carry it. */
export interface CloudTag {
  tag: string
  letter: string
  count: number
}

/** The letter a tag is listed under: its first letter without accents, and `#` for anything not a letter. */
export function cloudLetter(tag: string): string {
  const letter = groupOf(tag)
  return /^\p{L}$/u.test(letter) ? letter : '#'
}

/**
 * Every tag in the scope, with the number of series it would list.
 *
 * A tag is followed to the series list, whose tag filter matches a series by its own
 * tags or its books' (`search/condition.ts`), so that is what is counted: series
 * carrying the tag either way, each once - the number the click then shows.
 */
async function tagCloud(db: Kysely<DB>, scope: Scope): Promise<CloudTag[]> {
  const within = scope.everything ? sql`` : sql`where series_id in ${scope.series}`
  const rows = await sql<{ tag: string; count: number }>`
    select tag, count(*) as count from (
      select series_id, tag from series_metadata_tag ${within}
      union
      select series_id, tag from book_metadata_aggregation_tag ${within}
    )
    group by tag
  `.execute(db)
  const tags = new Map<string, number>()
  for (const row of rows.rows) {
    // Tags differing only by spaces around them are one tag to a reader.
    const tag = row.tag.trim()
    if (tag !== '') tags.set(tag, (tags.get(tag) ?? 0) + Number(row.count))
  }
  return [...tags.entries()]
    .map(([tag, count]) => ({ tag, letter: cloudLetter(tag), count }))
    .sort((left, right) => left.tag.localeCompare(right.tag))
}

export async function registerReferentialRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const register = (path: string, usePage: boolean) => {
    /** A route that answers with a list drawn from the scope of its request. */
    const list = <T>(route: string, read: (scope: Scope, query: Query) => Promise<T[]>) => {
      app.get(`${path}/${route}`, { preHandler: requireAuth }, async (req) => {
        const query = (req.query ?? {}) as Query
        const scope = scopeOf(db, await contentContext(db, req), query, (await allLibraryIds(db)).length)
        return paginated(scope === null ? [] : await read(scope, query), query, usePage)
      })
    }
    const strings = (route: string, sources: (query: Query) => Source[]) =>
      list(route, (scope, query) => valuesOf(db, scope, sources(query), text(query.search)))

    list('authors', (scope, query) => authorsOf(db, scope, text(query.search), text(query.role)))
    list('authors/names', async (scope, query) =>
      distinct((await authorsOf(db, scope, text(query.search), text(query.role))).map((author) => author.name)),
    )
    strings('authors/roles', () => [SERIES_ROLES, BOOK_ROLES])

    strings('genres', () => [GENRES])
    strings('sharing-labels', () => [SHARING_LABELS])
    strings('publishers', () => [PUBLISHERS])
    strings('languages', () => [LANGUAGES])
    strings('tags', (query) => tagSources(query.include))
    strings('tags/series', () => [SERIES_TAGS])
    strings('tags/book', () => [BOOK_TAGS])

    // Numbers, lowest first; the older API gave them as text.
    list<string | number>('age-ratings', async (scope) => {
      const rows = await db
        .selectFrom('series_metadata')
        .select('age_rating')
        .distinct()
        .where('age_rating', 'is not', null)
        .where('series_id', 'in', scope.series)
        .orderBy('age_rating')
        .execute()
      const ratings = rows.map((row) => Number(row.age_rating))
      return usePage ? ratings : ratings.map(String)
    })

    // The years the series came out in, newest first: a series is dated by its books.
    list(usePage ? 'series/release-years' : 'series/release-dates', async (scope) => {
      const rows = await db
        .selectFrom('book_metadata_aggregation')
        .select(sql<string>`substr(release_date, 1, 4)`.as('year'))
        .distinct()
        .where('release_date', 'is not', null)
        .where('series_id', 'in', scope.series)
        .execute()
      return rows
        .map((row) => row.year)
        .filter((year) => /^\d{4}$/.test(year))
        .sort((left, right) => Number(right) - Number(left))
    })
  }

  register('/api/v1', false)
  register('/api/v2', true)

  // Not the reference's: the page of every tag, sized by how much carries each.
  app.get('/api/v1/tags/cloud', { preHandler: requireAuth }, async (req) => {
    const query = (req.query ?? {}) as Query
    const scope = scopeOf(db, await contentContext(db, req), query, (await allLibraryIds(db)).length)
    return { tags: scope === null ? [] : await tagCloud(db, scope) }
  })
}
