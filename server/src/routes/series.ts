import { sql, type Kysely } from 'kysely'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth, requireRole } from '../auth/session.js'
import { announceSeries, seriesRef } from '../content-events.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { archiveEntries } from '../content/files.js'
import { findBooks, type BookQueryFilters } from './books.js'
import { buildBookDtos, buildSeriesDtos, loadSeriesCounts } from './content-data.js'
import type { SeriesCounts, SeriesRow } from './content-dto.js'
import { contentDisposition } from './content-disposition.js'
import { allowedSeries, contentContext, scopedLibraryIds, type ContentContext } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { applySeriesMetadataPatch } from './metadata.js'
import { toCollectionDto, type CollectionDto, type CollectionRow } from './organisation-dto.js'
import {
  applySort,
  booleanParam,
  isRegex,
  paging,
  parseSort,
  requiredValue,
  toArray,
  type SortKey,
  type SortSpec,
} from './query.js'
import { seriesCondition, type ConditionFilter } from '../search/condition.js'
import { INDEXES, matchFilter, relevanceSort } from '../search/fullText.js'
import { zipStream } from '../zip.js'

/**
 * Series browsing, metadata and series-level progress.
 *
 * Filtering happens in two stages. Structural filters run in SQL; content
 * restrictions and per-series read status are then applied in application code,
 * because both depend on rules that are much clearer as code than as SQL
 * (`contentRestrictionAllows`) or on aggregate counts (read status). When a
 * caller has no restrictions and asks for no read-status filter - the common
 * case - the whole thing stays in SQL and only the requested page is read.
 */

/**
 * What a series listing can be sorted by, under the names the reference gives them.
 *
 * As with books, a name that is missing is not refused but quietly ignored, so
 * this is the reference's whole list.
 */
export function seriesSorts(userId: string, collectionId?: string): Record<string, SortKey> {
  return {
    // The place a series was given in a collection, which only means something
    // when the request is about one collection.
    ...(collectionId === undefined
      ? {}
      : {
          'collection.number': sql<number>`(
            select cs_sort.number from collection_series cs_sort
            where cs_sort.series_id = series.id and cs_sort.collection_id = ${collectionId}
          )`,
        }),
    name: 'series.name',
    url: 'series.url',
    created: 'series.created_date',
    createdDate: 'series.created_date',
    lastModified: 'series.last_modified_date',
    lastModifiedDate: 'series.last_modified_date',
    booksCount: 'series.book_count',
    'metadata.title': 'series_metadata.title',
    'metadata.titleSort': 'series_metadata.title_sort',
    'metadata.lastModified': 'series_metadata.last_modified_date',
    'booksMetadata.releaseDate': 'book_metadata_aggregation.release_date',
    // When the caller last read any book of the series.
    readDate: sql<string>`(
      select max(rp_sort.read_date) from read_progress rp_sort
      join books rp_sort_book on rp_sort_book.id = rp_sort.book_id
      where rp_sort_book.series_id = series.id and rp_sort.user_id = ${userId}
    )`,
    random: sql<number>`random()`,
  }
}

export const SERIES_DEFAULT_SORT: SortSpec[] = [
  { column: 'series_metadata.title_sort', direction: 'asc' },
  { column: 'series.id', direction: 'asc' },
]

/** Creation time of the most recently added book, used by the `latest` listing. */
const NEWEST_BOOK_DATE = sql<string>`(
  select max(newest_book.created_date) from books newest_book where newest_book.series_id = series.id
)`

/** Books inside a series sort by reading order unless asked otherwise. */
const SERIES_BOOK_SORTS: Record<string, string> = {
  name: 'books.name',
  number: 'books.number',
  created: 'books.created_date',
  createdDate: 'books.created_date',
  lastModified: 'books.last_modified_date',
  lastModifiedDate: 'books.last_modified_date',
  fileSize: 'books.file_size',
  'metadata.title': 'book_metadata.title',
  'metadata.numberSort': 'book_metadata.number_sort',
  'metadata.releaseDate': 'book_metadata.release_date',
}

const SERIES_BOOK_DEFAULT_SORT: SortSpec[] = [
  { column: 'book_metadata.number_sort', direction: 'asc' },
  { column: 'books.id', direction: 'asc' },
]

export interface SeriesFilters {
  libraryIds: string[]
  search?: string
  /** A `pattern,field` regex search, with the field resolved to a column. */
  searchRegex?: { pattern: string; field: string }
  /** A translated search condition, ready to be a `where` clause. */
  condition?: ConditionFilter
  collectionIds: string[]
  statuses: string[]
  readStatuses: string[]
  publishers: string[]
  languages: string[]
  genres: string[]
  tags: string[]
  ageRatings: number[]
  releaseYears: number[]
  sharingLabels: string[]
  authors: string[]
  deleted: boolean | null
  complete: boolean | null
  oneshot: boolean | null
}

const LIVE_BOOK_COUNT = sql<number>`(
  select count(*) from books counted_book
  where counted_book.series_id = series.id and counted_book.deleted_date is null
)`

function seriesQuery(db: Kysely<DB>, filters: SeriesFilters, onlySeries: readonly string[] | null = null) {
  let query = db
    .selectFrom('series')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'series.id')
    .leftJoin('book_metadata_aggregation', 'book_metadata_aggregation.series_id', 'series.id')

  query = query.where('series.library_id', 'in', filters.libraryIds)
  // What a restricted user may see is decided in the query, so the database pages
  // the result. Decided afterwards, every series had to be fetched to find a page.
  if (onlySeries !== null) query = query.where('series.id', 'in', onlySeries)
  query =
    filters.deleted === true
      ? query.where('series.deleted_date', 'is not', null)
      : query.where('series.deleted_date', 'is', null)

  if (filters.oneshot !== null) query = query.where('series.oneshot', '=', filters.oneshot ? 1 : 0)
  if (filters.condition !== undefined) query = query.where(filters.condition)
  if (filters.statuses.length > 0) query = query.where('series_metadata.status', 'in', filters.statuses)
  if (filters.publishers.length > 0) query = query.where('series_metadata.publisher', 'in', filters.publishers)
  if (filters.languages.length > 0) query = query.where('series_metadata.language', 'in', filters.languages)

  if (filters.search !== undefined && filters.search !== '') {
    // A term that cannot match anything matches nothing, rather than dropping the
    // filter and answering with the whole library.
    const filter = matchFilter(db, INDEXES.SERIES, filters.search)
    query = filter === null ? query.where(sql<boolean>`false`) : query.where(filter)
  }

  if (filters.searchRegex !== undefined) {
    query = query.where(
      sql<boolean>`${sql.ref(`series_metadata.${filters.searchRegex.field}`)} regexp ${filters.searchRegex.pattern}`,
    )
  }

  // Age ratings are plain integers; -1 is the "no rating" bucket, which in the
  // schema is a null column rather than a sentinel value.
  if (filters.ageRatings.length > 0) {
    const rated = filters.ageRatings.filter((value) => value >= 0)
    const includeUnrated = filters.ageRatings.includes(-1)
    if (rated.length > 0 || includeUnrated) {
      query = query.where((eb) => {
        const clauses = []
        if (rated.length > 0) clauses.push(eb('series_metadata.age_rating', 'in', rated))
        if (includeUnrated) clauses.push(eb('series_metadata.age_rating', 'is', null))
        return eb.or(clauses)
      })
    }
  }

  if (filters.releaseYears.length > 0) {
    const years = filters.releaseYears
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('books')
          .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
          .select(sql<number>`1`.as('one'))
          .whereRef('books.series_id', '=', 'series.id')
          .where('books.deleted_date', 'is', null)
          .where((inner) =>
            inner.or(
              years.map((year) =>
                inner.and([
                  inner('book_metadata.release_date', '>=', `${year}-01-01`),
                  inner('book_metadata.release_date', '<', `${year + 1}-01-01`),
                ]),
              ),
            ),
          ),
      ),
    )
  }

  if (filters.tags.length > 0) {
    const tags = filters.tags
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('series_metadata_tag')
          .select(sql<number>`1`.as('one'))
          .whereRef('series_metadata_tag.series_id', '=', 'series.id')
          .where('series_metadata_tag.tag', 'in', tags),
      ),
    )
  }

  if (filters.genres.length > 0) {
    const genres = filters.genres
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('series_metadata_genre')
          .select(sql<number>`1`.as('one'))
          .whereRef('series_metadata_genre.series_id', '=', 'series.id')
          .where('series_metadata_genre.genre', 'in', genres),
      ),
    )
  }

  if (filters.sharingLabels.length > 0) {
    const labels = filters.sharingLabels
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('series_metadata_sharing')
          .select(sql<number>`1`.as('one'))
          .whereRef('series_metadata_sharing.series_id', '=', 'series.id')
          .where('series_metadata_sharing.label', 'in', labels),
      ),
    )
  }
  if (filters.collectionIds.length > 0) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('collection_series')
          .select(sql<number>`1`.as('one'))
          .whereRef('collection_series.series_id', '=', 'series.id')
          .where('collection_series.collection_id', 'in', filters.collectionIds),
      ),
    )
  }

  if (filters.authors.length > 0) {
    const names = filters.authors
    query = query.where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('series_metadata_author')
            .select(sql<number>`1`.as('one'))
            .whereRef('series_metadata_author.series_id', '=', 'series.id')
            .where('series_metadata_author.name', 'in', names),
        ),
        eb.exists(
          eb
            .selectFrom('books')
            .innerJoin('book_metadata_author', 'book_metadata_author.book_id', 'books.id')
            .select(sql<number>`1`.as('one'))
            .whereRef('books.series_id', '=', 'series.id')
            .where('book_metadata_author.name', 'in', names),
        ),
      ]),
    )
  }

  if (filters.complete === true) {
    query = query.where(
      sql<boolean>`series_metadata.total_book_count is not null and series_metadata.total_book_count = ${LIVE_BOOK_COUNT}`,
    )
  } else if (filters.complete === false) {
    query = query.where(
      sql<boolean>`(series_metadata.total_book_count is null or series_metadata.total_book_count <> ${LIVE_BOOK_COUNT})`,
    )
  }

  return query
}

/** Read status of a series, from its per-book counts. */
function seriesReadStatus(counts: SeriesCounts): 'READ' | 'IN_PROGRESS' | 'UNREAD' {
  if (counts.booksCount > 0 && counts.booksReadCount === counts.booksCount) return 'READ'
  if (counts.booksReadCount > 0 || counts.booksInProgressCount > 0) return 'IN_PROGRESS'
  return 'UNREAD'
}

function matchesReadStatus(counts: SeriesCounts, wanted: readonly string[]): boolean {
  const status = seriesReadStatus(counts)
  return wanted.includes(status)
}

async function loadSeriesRows(db: Kysely<DB>, ids: readonly string[]): Promise<SeriesRow[]> {
  if (ids.length === 0) return []
  const rows = await db.selectFrom('series').selectAll().where('id', 'in', ids).execute()
  const byId = new Map(rows.map((row) => [row.id, row as unknown as SeriesRow]))
  return ids.map((id) => byId.get(id)).filter((row): row is SeriesRow => row !== undefined)
}

export interface SeriesPage {
  rows: SeriesRow[]
  total: number
}

export async function findSeries(
  db: Kysely<DB>,
  context: ContentContext,
  filters: SeriesFilters,
  sorts: readonly SortSpec[],
  page: number,
  size: number,
  unpaged: boolean,
): Promise<SeriesPage> {
  if (filters.libraryIds.length === 0) return { rows: [], total: 0 }

  const needsPostFilter = filters.readStatuses.length > 0
  const onlySeries = context.restrictedSeriesIds

  if (!needsPostFilter) {
    const counted = await seriesQuery(db, filters, onlySeries)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow()
    const total = Number(counted.total)

    let idsQuery = applySort(seriesQuery(db, filters, onlySeries).select('series.id'), sorts).orderBy('series.id')
    if (!unpaged) idsQuery = idsQuery.limit(size).offset(page * size)
    const ids = (await idsQuery.execute()).map((row) => row.id)
    return { rows: await loadSeriesRows(db, ids), total }
  }

  const ordered = (
    await applySort(seriesQuery(db, filters, onlySeries).select('series.id'), sorts)
      .orderBy('series.id')
      .execute()
  ).map((row) => row.id)

  let candidates = ordered

  if (filters.readStatuses.length > 0) {
    const counts = await loadSeriesCounts(db, candidates, context.user.id)
    candidates = candidates.filter((id) =>
      matchesReadStatus(
        counts.get(id) ?? { booksCount: 0, booksReadCount: 0, booksInProgressCount: 0 },
        filters.readStatuses,
      ),
    )
  }

  const total = candidates.length
  const window = unpaged ? candidates : candidates.slice(page * size, page * size + size)
  return { rows: await loadSeriesRows(db, window), total }
}

/** Shared listing entry point, so nested listings behave exactly like `/series`. */
export async function seriesPage(
  db: Kysely<DB>,
  context: ContentContext,
  filters: SeriesFilters,
  sorts: readonly SortSpec[],
  page: number,
  size: number,
  unpaged: boolean,
) {
  const { rows, total } = await findSeries(db, context, filters, sorts, page, size, unpaged)
  const dtos = await buildSeriesDtos(db, rows, context.user.id)
  return springPage(dtos, page, unpaged ? total : size, total)
}

function integerParams(value: unknown): number[] {
  return toArray(value)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry))
}

/**
 * A `search_regex` parameter.
 *
 * The contract documents `pattern,field`, with `TITLE` and `TITLE_SORT` as the fields,
 * and that is what a value in that form is read as. A value that names an unknown
 * field is dropped rather than refused, which is what the reference does with it. A
 * value that is not in that form at all - no comma - is read as a pattern for the
 * title, because that is how this server read it before it read fields, and answering
 * with every series would be a silent loss of the filter somebody asked for.
 */
export function regexSearch(value: unknown): { pattern: string; field: string } | undefined {
  if (typeof value !== 'string' || value === '') return undefined

  const separator = value.lastIndexOf(',')
  if (separator < 0) return { pattern: value, field: 'title' }

  const pattern = value.slice(0, separator)
  const field = value
    .slice(separator + 1)
    .trim()
    .toLowerCase()
  if (field === 'title') return { pattern, field: 'title' }
  if (field === 'title_sort') return { pattern, field: 'title_sort' }
  return undefined
}

export function filtersFrom(
  context: ContentContext,
  query: Record<string, unknown>,
  body: Record<string, unknown> = {},
): SeriesFilters {
  const search = typeof query.search === 'string' && query.search !== '' ? query.search : undefined
  const fullText =
    typeof body.fullTextSearch === 'string' && body.fullTextSearch !== '' ? body.fullTextSearch : undefined

  return {
    libraryIds: scopedLibraryIds(context, query.library_id),
    search: search ?? fullText,
    searchRegex: regexSearch(query.search_regex),
    collectionIds: toArray(query.collection_id),
    statuses: toArray(query.status),
    readStatuses: toArray(query.read_status),
    publishers: toArray(query.publisher),
    languages: toArray(query.language),
    genres: toArray(query.genre),
    tags: toArray(query.tag),
    ageRatings: integerParams(query.age_rating),
    releaseYears: integerParams(query.release_year),
    sharingLabels: toArray(query.sharing_label),
    authors: toArray(query.author),
    deleted: booleanParam(query.deleted),
    complete: booleanParam(query.complete),
    oneshot: booleanParam(query.oneshot),
  }
}

/**
 * The group a series is counted in: the first character of its sort title, in
 * lower case, whatever that character is.
 *
 * That is what the reference answers. Deciding which characters make a letter of
 * the navigation, and that the rest are `#`, is left to the client, because it
 * depends on the alphabet the client is showing: under a Japanese grouping `か` is
 * a group of its own and not one of the rest.
 *
 * Accents are dropped the way the title filter drops them, so the count under a
 * letter is the number of series that choosing the letter then lists.
 */
export function groupOf(titleSort: string): string {
  // By code point, so a character outside the basic plane is not cut in half.
  const [first = ''] = titleSort.trimStart()
  return first
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export async function registerSeriesRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  /** Resolve a series the caller may see, distinguishing 404 from 403. */
  const resolve = async (
    context: ContentContext,
    seriesId: string,
  ): Promise<{ row: SeriesRow } | { status: 403 | 404 }> => {
    const row = await db.selectFrom('series').selectAll().where('id', '=', seriesId).executeTakeFirst()
    if (!row) return { status: 404 }
    const series = row as unknown as SeriesRow
    if (!context.libraryIds.includes(series.library_id)) return { status: 403 }
    if (allowedSeries(context)?.has(series.id) === false) {
      return { status: 403 }
    }
    return { row: series }
  }

  const list = async (req: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true
    const filters = filtersFrom(context, query, body)

    if (filters.searchRegex !== undefined && !isRegex(filters.searchRegex.pattern)) {
      return reply.code(400).send({ validationErrors: { search_regex: 'must be a valid regular expression' } })
    }

    if (body.condition !== undefined) {
      const translated = seriesCondition(body.condition, { userId: context.user.id })
      if ('error' in translated) return reply.code(400).send({ message: translated.error })
      filters.condition = translated.filter
    }

    // A search ranks by how well each series matches, unless the caller asked for an
    // order of their own - which is what the reference does too. A term with nothing
    // searchable in it has nothing to rank by.
    const relevance = filters.search === undefined ? null : relevanceSort(INDEXES.SERIES, filters.search)
    const allowed = seriesSorts(
      context.user.id,
      filters.collectionIds[0] ?? requiredValue(body.condition, 'collectionId'),
    )
    const sorts = parseSort(
      query.sort,
      relevance === null ? allowed : { ...allowed, relevance },
      relevance === null ? SERIES_DEFAULT_SORT : [{ column: relevance, direction: 'asc' }],
    )

    return seriesPage(db, context, filters, sorts, page, size, unpaged)
  }

  app.get('/api/v1/series', { preHandler: requireAuth }, async (req, reply) => list(req, reply, {}))

  app.post('/api/v1/series/list', { preHandler: requireAuth }, async (req, reply) =>
    list(req, reply, (req.body ?? {}) as Record<string, unknown>),
  )

  const groups = async (req: FastifyRequest, body: Record<string, unknown>) => {
    const context = await contentContext(db, req)
    const filters = filtersFrom(context, (req.query ?? {}) as Record<string, unknown>, body)
    const { rows } = await findSeries(db, context, filters, SERIES_DEFAULT_SORT, 0, 0, true)
    if (rows.length === 0) return []

    const metadata = await db
      .selectFrom('series_metadata')
      .select(['series_id', 'title_sort'])
      .where(
        'series_id',
        'in',
        rows.map((row) => row.id),
      )
      .execute()
    const titleSort = new Map(metadata.map((row) => [row.series_id, row.title_sort]))

    const counts = new Map<string, number>()
    for (const row of rows) {
      const group = groupOf(titleSort.get(row.id) ?? row.name)
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((left, right) => left.group.localeCompare(right.group))
  }

  app.get('/api/v1/series/alphabetical-groups', { preHandler: requireAuth }, async (req) => groups(req, {}))

  app.post('/api/v1/series/list/alphabetical-groups', { preHandler: requireAuth }, async (req) =>
    groups(req, (req.body ?? {}) as Record<string, unknown>),
  )

  /**
   * The three "recent" listings.
   *
   * `latest` follows newly added books, `new` follows series that were only just
   * created, and `updated` follows anything whose metadata or contents changed.
   */
  const recent = (path: string, sort: SortSpec) => {
    app.get(path, { preHandler: requireAuth }, async (req) => {
      const context = await contentContext(db, req)
      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, size } = paging(query)
      const unpaged = booleanParam(query.unpaged) === true

      const filters: SeriesFilters = {
        libraryIds: scopedLibraryIds(context, query.library_id),
        collectionIds: [],
        statuses: [],
        readStatuses: [],
        publishers: [],
        languages: [],
        genres: [],
        tags: [],
        ageRatings: [],
        releaseYears: [],
        sharingLabels: [],
        authors: [],
        deleted: booleanParam(query.deleted),
        complete: null,
        oneshot: booleanParam(query.oneshot),
      }

      const { rows, total } = await findSeries(db, context, filters, [sort], page, size, unpaged)
      const dtos = await buildSeriesDtos(db, rows, context.user.id)
      return springPage(dtos, page, unpaged ? total : size, total)
    })
  }

  recent('/api/v1/series/latest', { column: NEWEST_BOOK_DATE, direction: 'desc' })
  recent('/api/v1/series/new', { column: 'series.created_date', direction: 'desc' })
  recent('/api/v1/series/updated', { column: 'series.last_modified_date', direction: 'desc' })

  const releaseDates = async (libraryIds: string[]) => {
    if (libraryIds.length === 0) return []
    const rows = await db
      .selectFrom('book_metadata')
      .innerJoin('books', 'books.id', 'book_metadata.book_id')
      .innerJoin('series', 'series.id', 'books.series_id')
      .select('book_metadata.release_date')
      .where('series.library_id', 'in', libraryIds)
      .where('book_metadata.release_date', 'is not', null)
      .execute()

    const years = new Set<number>()
    for (const row of rows) {
      const year = Number.parseInt((row.release_date ?? '').slice(0, 4), 10)
      if (Number.isFinite(year)) years.add(year)
    }
    return [...years].sort((left, right) => left - right)
  }

  app.get('/api/v1/series/release-dates', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const scoped = scopedLibraryIds(context, (req.query as Record<string, unknown>).library_id)
    return (await releaseDates(scoped)).map(String)
  })

  app.get('/api/v2/series/release-years', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    return releaseDates(context.libraryIds)
  })

  app.get<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }
      const dtos = await buildSeriesDtos(db, [found.row], context.user.id)
      return dtos[0]
    },
  )

  app.get<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/books',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }

      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, size } = paging(query)
      const unpaged = booleanParam(query.unpaged) === true
      const filters: BookQueryFilters = {
        libraryIds: context.libraryIds,
        seriesId: req.params.seriesId,
        mediaStatuses: toArray(query.media_status),
        readStatuses: toArray(query.read_status),
        tags: toArray(query.tag),
        deleted: booleanParam(query.deleted),
      }

      const { rows, total } = await findBooks(
        db,
        context,
        filters,
        parseSort(query.sort, SERIES_BOOK_SORTS, SERIES_BOOK_DEFAULT_SORT),
        page,
        size,
        unpaged,
      )
      const dtos = await buildBookDtos(db, rows, context.user.id)
      return springPage(dtos, page, unpaged ? total : size, total)
    },
  )

  app.get<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/collections',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }

      const rows = await db
        .selectFrom('collection_series')
        .innerJoin('collections', 'collections.id', 'collection_series.collection_id')
        .selectAll('collections')
        .where('collection_series.series_id', '=', req.params.seriesId)
        .orderBy('collections.name')
        .execute()
      if (rows.length === 0) return [] satisfies CollectionDto[]

      const members = await db
        .selectFrom('collection_series')
        .select(['collection_id', 'series_id'])
        .where(
          'collection_id',
          'in',
          rows.map((row) => row.id),
        )
        .orderBy('number')
        .execute()

      const allowed = allowedSeries(context)
      const seriesByCollection = new Map<string, string[]>()
      for (const member of members) {
        if (allowed !== null && !allowed.has(member.series_id)) continue
        const list = seriesByCollection.get(member.collection_id)
        if (list) list.push(member.series_id)
        else seriesByCollection.set(member.collection_id, [member.series_id])
      }

      return rows.map((row) => toCollectionDto(row as unknown as CollectionRow, seriesByCollection.get(row.id) ?? []))
    },
  )

  app.patch<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/metadata',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('series_metadata')
        .select('series_id')
        .where('series_id', '=', req.params.seriesId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Series not found' })

      const result = await applySeriesMetadataPatch(
        db,
        req.params.seriesId,
        (req.body ?? {}) as Record<string, unknown>,
      )
      if (!result.ok) return reply.code(400).send({ validationErrors: result.errors })

      const changed = await seriesRef(db, req.params.seriesId)
      if (changed) announceSeries(opts.events, 'SeriesChanged', changed)
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/metadata/refresh',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('series')
        .select('id')
        .where('id', '=', req.params.seriesId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Series not found' })

      await enqueueJob(db, {
        type: 'RefreshSeriesMetadata',
        uniqueKey: `REFRESH_SERIES_METADATA_${req.params.seriesId}`,
        priority: JOB_PRIORITY.HIGH,
        payload: { seriesId: req.params.seriesId },
      })

      // The reference's endpoint also refreshes the books of the series, with the
      // artwork beside each of them and in the series' own folder.
      const books = await db
        .selectFrom('books')
        .select('id')
        .where('series_id', '=', req.params.seriesId)
        .where('deleted_date', 'is', null)
        .orderBy('number')
        .execute()

      for (const book of books) {
        await enqueueJob(db, {
          type: 'RefreshBookMetadata',
          uniqueKey: `REFRESH_BOOK_METADATA_${book.id}`,
          priority: JOB_PRIORITY.HIGH,
          payload: { bookId: book.id },
        })
        await enqueueJob(db, {
          type: 'RefreshBookLocalArtwork',
          uniqueKey: `REFRESH_BOOK_LOCAL_ARTWORK_${book.id}`,
          priority: JOB_PRIORITY.HIGH,
          payload: { bookId: book.id },
        })
      }

      await enqueueJob(db, {
        type: 'RefreshSeriesLocalArtwork',
        uniqueKey: `REFRESH_SERIES_LOCAL_ARTWORK_${req.params.seriesId}`,
        priority: JOB_PRIORITY.HIGH,
        payload: { seriesId: req.params.seriesId },
      })
      return reply.code(202).send()
    },
  )

  app.post<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/analyze',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('series')
        .select('id')
        .where('id', '=', req.params.seriesId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Series not found' })

      await enqueueJob(db, {
        type: 'AnalyzeSeries',
        uniqueKey: `ANALYZE_SERIES_${req.params.seriesId}`,
        priority: JOB_PRIORITY.DEFAULT,
        payload: { seriesId: req.params.seriesId },
      })
      return reply.code(202).send()
    },
  )

  /** Mark every book in the series as read for the caller. */
  app.post<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/read-progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }

      const now = new Date().toISOString()
      const books = await db
        .selectFrom('books')
        .select('id')
        .where('series_id', '=', req.params.seriesId)
        .where('deleted_date', 'is', null)
        .execute()

      for (const book of books) {
        await db
          .insertInto('read_progress')
          .values({
            user_id: context.user.id,
            book_id: book.id,
            page: 0,
            completed: 1,
            read_date: now,
            device_id: null,
            device_name: null,
            locator: null,
            created_date: now,
            last_modified_date: now,
          })
          .onConflict((oc) =>
            oc.columns(['user_id', 'book_id']).doUpdateSet({ completed: 1, read_date: now, last_modified_date: now }),
          )
          .execute()
      }
      return reply.code(204).send()
    },
  )

  app.delete<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/read-progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }

      await db
        .deleteFrom('read_progress')
        .where('user_id', '=', context.user.id)
        .where('book_id', 'in', db.selectFrom('books').select('id').where('series_id', '=', req.params.seriesId))
        .execute()
      return reply.code(204).send()
    },
  )

  /**
   * Download a whole series as a ZIP.
   *
   * Each entry is named after the book's file, and a book whose file is no longer
   * on disk is skipped rather than failing the whole download.
   */
  app.get<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/file',
    { preHandler: requireRole('FILE_DOWNLOAD') },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await resolve(context, req.params.seriesId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Series not found' : 'Forbidden' })
      }

      const metadata = await db
        .selectFrom('series_metadata')
        .select('title')
        .where('series_id', '=', req.params.seriesId)
        .executeTakeFirst()
      const books = await db
        .selectFrom('books')
        .select('id')
        .where('series_id', '=', req.params.seriesId)
        .where('deleted_date', 'is', null)
        .orderBy('number')
        .execute()

      const entries = await archiveEntries(
        db,
        books.map((book) => book.id),
        (fileName) => fileName,
      )
      const fileName = `${metadata?.title ?? found.row.name}.zip`
      return reply
        .header('content-disposition', contentDisposition('attachment', fileName))
        .type('application/zip')
        .send(zipStream(entries))
    },
  )
}
