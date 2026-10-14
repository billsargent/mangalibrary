import { sql, type Kysely } from 'kysely'
import { profileFor } from '../media/kinds.js'
import {
  ProgressionError,
  epubProgress,
  pagedProgress,
  type LocatorProgress,
  type StoredPosition,
} from './progression.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../auth/session.js'
import { announceBook, announceSeries, bookRef, seriesRef } from '../content-events.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob, enqueueJobs } from '../jobs.js'
import { COPY_MODES } from '../media/import.js'
import { aggregateSeriesMetadata } from '../metadata/aggregation.js'
import { buildBookDtos } from './content-data.js'
import type { BookRow } from './content-dto.js'
import { allowedSeries, contentContext, scopedLibraryIds, type ContentContext } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { applyBookMetadataPatch } from './metadata.js'
import { toReadListDto, type ReadListRow } from './organisation-dto.js'
import {
  applySort,
  booleanParam,
  paging,
  parseSort,
  requiredValue,
  toArray,
  type SortKey,
  type SortSpec,
} from './query.js'
import { bookCondition, type ConditionFilter } from '../search/condition.js'
import { INDEXES, matchFilter, relevanceSort } from '../search/fullText.js'

/**
 * Book browsing, metadata, progression and progress.
 *
 * Visibility follows the series the book belongs to: there is no per-book
 * restriction in Komga, and a book whose series the caller may not see is
 * reported as forbidden rather than missing.
 */

/**
 * What a book listing can be sorted by, under the names the reference gives them.
 *
 * Several names mean the same thing - `created` and `createdDate` - because the
 * reference accepts both and its clients use both. A name that is missing here is
 * not refused: the listing comes back in its default order, which looks like the
 * sort was ignored, so the list is the reference's whole list.
 */
export function bookSorts(userId: string, readListId?: string): Record<string, SortKey> {
  // Progress belongs to whoever is asking, so sorting by it is theirs too.
  const progress = (column: 'read_date' | 'last_modified_date') => sql<string>`(
    select rp_sort.${sql.ref(column)} from read_progress rp_sort
    where rp_sort.book_id = books.id and rp_sort.user_id = ${userId}
  )`

  return {
    // The place a book was given in a read list, which only means something when
    // the request is about one read list.
    ...(readListId === undefined
      ? {}
      : {
          'readList.number': sql<number>`(
            select rb_sort.number from readlist_book rb_sort
            where rb_sort.book_id = books.id and rb_sort.readlist_id = ${readListId}
          )`,
        }),
    name: 'books.name',
    number: 'books.number',
    series: 'series_metadata.title_sort_key',
    url: 'books.url',
    created: 'books.created_date',
    createdDate: 'books.created_date',
    lastModified: 'books.last_modified_date',
    lastModifiedDate: 'books.last_modified_date',
    fileSize: 'books.file_size',
    size: 'books.file_size',
    fileHash: 'books.file_hash',
    'media.status': 'media.status',
    'media.comment': 'media.comment',
    'media.mediaType': 'media.media_type',
    'media.pagesCount': 'media.page_count',
    'metadata.title': 'book_metadata.title',
    'metadata.numberSort': 'book_metadata.number_sort',
    'metadata.releaseDate': 'book_metadata.release_date',
    'readProgress.readDate': progress('read_date'),
    'readProgress.lastModified': progress('last_modified_date'),
  }
}

const BOOK_DEFAULT_SORT: SortSpec[] = [
  { column: 'book_metadata.number_sort', direction: 'asc' },
  { column: 'books.id', direction: 'asc' },
]

export interface BookQueryFilters {
  libraryIds: string[]
  seriesId?: string
  search?: string
  /** A translated search condition, ready to be a `where` clause. */
  condition?: ConditionFilter
  mediaStatuses?: string[]
  readStatuses?: string[]
  tags?: string[]
  releasedAfter?: string
  deleted?: boolean | null
}

/** The tables beside `books` that a listing may have to join. */
type BookJoin = 'book_metadata' | 'series' | 'series_metadata' | 'media'
const BOOK_JOINS: readonly BookJoin[] = ['book_metadata', 'series', 'series_metadata', 'media']

/** Which table a listing starts from. Anything but `books` is a forced order: see `DRIVEN`. */
type BookDrive = 'books' | 'book_metadata' | 'series_metadata'

/** The query with every table joined, which is only here to give the builder its type. */
function _everyJoin(db: Kysely<DB>) {
  return db
    .selectFrom('books')
    .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
    .innerJoin('series', 'series.id', 'books.series_id')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'books.series_id')
    .leftJoin('media', 'media.book_id', 'books.id')
}
type BookQuery = ReturnType<typeof _everyJoin>

/**
 * Which of the joinable tables a piece of SQL names.
 *
 * A filter or a sort arrives as a column name or as SQL somebody built, and either
 * way it says which tables it needs by naming them. A name inside a longer one -
 * `collection_series.`, `book_metadata_tag.` - is not this table.
 */
function joinsNamedIn(db: Kysely<DB>, fragments: readonly (SortKey | ConditionFilter | undefined)[]): Set<BookJoin> {
  const named = new Set<BookJoin>()
  for (const fragment of fragments) {
    if (fragment === undefined) continue
    const text = typeof fragment === 'string' ? fragment : fragment.compile(db).sql
    for (const table of BOOK_JOINS) {
      if (new RegExp(`(?<![\\w"])"?${table}"?\\.`).test(text)) named.add(table)
    }
  }
  return named
}

/** The books a reader has read, is reading, or has not opened, as a filter. */
function readStatusFilter(userId: string, statuses: readonly string[]): ConditionFilter {
  // Written as lists of ids so that the database can start from the reader's
  // progress - a handful of rows - rather than ask about every book in turn.
  const parts: ConditionFilter[] = []
  if (statuses.includes('READ')) {
    parts.push(
      sql<boolean>`books.id in (select book_id from read_progress where user_id = ${userId} and completed = 1)`,
    )
  }
  if (statuses.includes('IN_PROGRESS')) {
    parts.push(
      sql<boolean>`books.id in (select book_id from read_progress where user_id = ${userId} and completed = 0)`,
    )
  }
  if (statuses.includes('UNREAD')) {
    parts.push(sql<boolean>`books.id not in (select book_id from read_progress where user_id = ${userId})`)
  }
  return parts.length === 0 ? sql<boolean>`false` : sql<boolean>`(${sql.join(parts, sql` or `)})`
}

/**
 * The listing query, joining only the tables it is told are needed.
 *
 * Every book has exactly one row in each of them, so leaving one out changes what
 * the query costs and not what it finds. On 200,000 books, counting through all
 * four joins took 220 ms; counting `books` alone takes 9.
 */
function bookQuery(
  db: Kysely<DB>,
  filters: BookQueryFilters,
  onlySeries: readonly string[] | null,
  joins: ReadonlySet<BookJoin>,
  userId: string,
  drive: BookDrive = 'books',
  /** Whether the rows are to be read in the order of the sort's index. */
  readInOrder = false,
): BookQuery {
  // `CROSS JOIN` is how SQLite is told to keep the order the tables are written
  // in. Starting from the table a listing is sorted by lets it read that table's
  // index in order and stop after a page, instead of sorting the whole library.
  // The builder has no word for it, so the two tables are written out, under the
  // name the rest of the query already uses for the second.
  let from: unknown
  if (drive === 'book_metadata') {
    from = db
      .selectFrom(sql`book_metadata cross join books`.as('books'))
      .where(sql<boolean>`books.id = book_metadata.book_id`)
  } else if (drive === 'series_metadata') {
    from = db
      .selectFrom(sql`series_metadata cross join books`.as('books'))
      .where(sql<boolean>`books.series_id = series_metadata.series_id`)
  } else {
    from = db.selectFrom('books')
  }
  let query = from as BookQuery
  if (joins.has('book_metadata') && drive !== 'book_metadata') {
    query = query.innerJoin('book_metadata', 'book_metadata.book_id', 'books.id') as unknown as BookQuery
  }
  if (joins.has('series')) query = query.innerJoin('series', 'series.id', 'books.series_id') as unknown as BookQuery
  if (joins.has('series_metadata') && drive !== 'series_metadata') {
    query = query.innerJoin('series_metadata', 'series_metadata.series_id', 'books.series_id') as unknown as BookQuery
  }
  if (joins.has('media')) query = query.leftJoin('media', 'media.book_id', 'books.id') as unknown as BookQuery

  // Read in the order of a sort's index, the library is checked on each book as it
  // comes, not looked up: the plus sign is how SQLite is told not to reach for the
  // index of libraries instead, which would find every book and then sort them all.
  const inOrder = drive !== 'books' || readInOrder
  query = inOrder
    ? query.where(sql<string>`+books.library_id`, 'in', filters.libraryIds)
    : query.where('books.library_id', 'in', filters.libraryIds)
  // What a restricted user may see is decided in the query, so the database pages
  // the result. Decided afterwards, every book had to be fetched to find a page.
  if (onlySeries !== null) query = query.where('books.series_id', 'in', onlySeries)
  query =
    filters.deleted === true
      ? query.where('books.deleted_date', 'is not', null)
      : query.where('books.deleted_date', 'is', null)

  if (filters.readStatuses !== undefined && filters.readStatuses.length > 0) {
    query = query.where(readStatusFilter(userId, filters.readStatuses))
  }

  if (filters.seriesId !== undefined) query = query.where('books.series_id', '=', filters.seriesId)

  if (filters.condition !== undefined) query = query.where(filters.condition)

  if (filters.search !== undefined && filters.search !== '') {
    // A term that cannot match anything - punctuation only - matches nothing, rather
    // than dropping the filter and answering with the whole library.
    const filter = matchFilter(db, INDEXES.BOOKS, filters.search)
    query = filter === null ? query.where(sql<boolean>`false`) : query.where(filter)
  }

  if (filters.mediaStatuses !== undefined && filters.mediaStatuses.length > 0) {
    query = query.where('media.status', 'in', filters.mediaStatuses)
  }

  if (filters.tags !== undefined && filters.tags.length > 0) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('book_metadata_tag')
          .select(sql<number>`1`.as('one'))
          .whereRef('book_metadata_tag.book_id', '=', 'books.id')
          .where('book_metadata_tag.tag', 'in', filters.tags ?? []),
      ),
    )
  }

  if (filters.releasedAfter !== undefined && filters.releasedAfter !== '') {
    query = query.where('book_metadata.release_date', '>=', filters.releasedAfter)
  }

  return query
}

async function loadBookRows(db: Kysely<DB>, ids: readonly string[]): Promise<BookRow[]> {
  if (ids.length === 0) return []
  const rows = await db.selectFrom('books').selectAll().where('id', 'in', ids).execute()
  const byId = new Map(rows.map((row) => [row.id, row as unknown as BookRow]))
  return ids.map((id) => byId.get(id)).filter((row): row is BookRow => row !== undefined)
}

export interface BooksPage {
  rows: BookRow[]
  total: number
}

export interface ReadStatus {
  read: Set<string>
  inProgress: Set<string>
}

/**
 * The caller's progress, loaded wholesale.
 *
 * Reading every progress row for the user is cheaper than an `IN` list over the
 * whole library, and it keeps the "unread" test - which is about books with no
 * progress row at all - expressible here at all.
 */
export async function loadReadStatus(db: Kysely<DB>, userId: string): Promise<ReadStatus> {
  const rows = await db
    .selectFrom('read_progress')
    .select(['book_id', 'completed'])
    .where('user_id', '=', userId)
    .execute()

  const status: ReadStatus = { read: new Set(), inProgress: new Set() }
  for (const row of rows) {
    if (row.completed === 1) status.read.add(row.book_id)
    else status.inProgress.add(row.book_id)
  }
  return status
}

export function matchesReadStatus(status: ReadStatus, wanted: readonly string[], bookId: string): boolean {
  const read = status.read.has(bookId)
  const started = status.inProgress.has(bookId)
  if (wanted.includes('READ') && read) return true
  if (wanted.includes('IN_PROGRESS') && started) return true
  if (wanted.includes('UNREAD') && !read && !started) return true
  return false
}

/**
 * Sorts a listing can be read in order for, off an index, when nothing narrows it
 * but the library: the table to start from, and the column that breaks ties in the
 * same index. Each has an index of exactly these two columns (migrations 0023, 0027).
 */
const DRIVEN: Record<string, { drive: BookDrive; tiebreak: string }> = {
  'series_metadata.title_sort_key': { drive: 'series_metadata', tiebreak: 'books.id' },
  'book_metadata.number_sort': { drive: 'book_metadata', tiebreak: 'book_metadata.book_id' },
  'book_metadata.release_date': { drive: 'book_metadata', tiebreak: 'book_metadata.book_id' },
  'books.created_date': { drive: 'books', tiebreak: 'books.id' },
}

/**
 * Whether a listing is narrowed by nothing but which libraries it is of.
 *
 * Only then is it right to read the sort's index in order: a listing that is of
 * one series, or of the five books somebody is reading, is found faster from what
 * narrows it, and reading the whole index to find those five would be slower.
 */
function narrowedByLibraryOnly(
  db: Kysely<DB>,
  filters: BookQueryFilters,
  onlySeries: readonly string[] | null,
): boolean {
  if (onlySeries !== null || filters.seriesId !== undefined) return false
  if (filters.search !== undefined && filters.search !== '') return false
  if ((filters.mediaStatuses?.length ?? 0) > 0 || (filters.readStatuses?.length ?? 0) > 0) return false
  if ((filters.tags?.length ?? 0) > 0) return false
  if (filters.releasedAfter !== undefined && filters.releasedAfter !== '') return false
  if (filters.condition === undefined) return true
  // A condition is SQL by now. With what it says about the library taken out, one
  // that says nothing else has no other column and no subquery left in it.
  const rest = filters.condition.compile(db).sql.replaceAll('"books"."library_id"', '')
  return !/[A-Za-z_]\w*"?\s*\.|\bselect\b|\bexists\b/i.test(rest)
}

export async function findBooks(
  db: Kysely<DB>,
  context: ContentContext,
  filters: BookQueryFilters,
  sorts: readonly SortSpec[],
  page: number,
  size: number,
  unpaged: boolean,
): Promise<BooksPage> {
  if (filters.libraryIds.length === 0) return { rows: [], total: 0 }

  const onlySeries = context.restrictedSeriesIds
  const userId = context.user.id

  // The tables the filters name are needed to count; the sorts' as well to order.
  const filterJoins = joinsNamedIn(db, [
    filters.condition,
    (filters.mediaStatuses?.length ?? 0) > 0 ? 'media.status' : undefined,
    filters.releasedAfter !== undefined && filters.releasedAfter !== '' ? 'book_metadata.release_date' : undefined,
  ])
  const counted = await bookQuery(db, filters, onlySeries, filterJoins, userId)
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .executeTakeFirstOrThrow()
  const total = Number(counted.total)

  // The book's id settles ties, and is always the last word: a sort that names it
  // as well would only say it twice.
  const ordering = sorts.filter((spec) => spec.column !== 'books.id')
  const first = ordering[0]
  const driven =
    first !== undefined && typeof first.column === 'string' && narrowedByLibraryOnly(db, filters, onlySeries)
      ? DRIVEN[first.column]
      : undefined
  const sortJoins = joinsNamedIn(
    db,
    ordering.map((spec) => spec.column),
  )
  const joins = new Set([...filterJoins, ...sortJoins])

  let idsQuery = applySort(
    bookQuery(db, filters, onlySeries, joins, userId, driven?.drive ?? 'books', driven !== undefined).select(
      'books.id',
    ),
    ordering,
  )
  // Read off an index, ties are broken the way the index runs - newest first means
  // highest id first among books added together - so that the index can be followed
  // to the end of the page. Otherwise by id, ascending, as it always was.
  idsQuery =
    driven !== undefined && first !== undefined
      ? idsQuery.orderBy(driven.tiebreak as 'books.id', first.direction)
      : idsQuery.orderBy('books.id')
  if (!unpaged) idsQuery = idsQuery.limit(size).offset(page * size)
  const ids = (await idsQuery.execute()).map((row) => row.id)
  return { rows: await loadBookRows(db, ids), total }
}

function searchTerm(query: Record<string, unknown>, body: Record<string, unknown>): string | undefined {
  const fromQuery = query.search
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery
  const fullText = body.fullTextSearch
  return typeof fullText === 'string' && fullText !== '' ? fullText : undefined
}

export async function bookById(
  db: Kysely<DB>,
  context: ContentContext,
  bookId: string,
): Promise<{ row: BookRow } | { status: 403 | 404 }> {
  const row = await db.selectFrom('books').selectAll().where('id', '=', bookId).executeTakeFirst()
  if (!row) return { status: 404 }

  const book = row as unknown as BookRow
  if (!context.libraryIds.includes(book.library_id)) return { status: 403 }
  if (allowedSeries(context)?.has(book.series_id) === false) {
    return { status: 403 }
  }
  return { row: book }
}

/** Compose the book DTO response for one id, honouring visibility. */
export async function sendBook(
  db: Kysely<DB>,
  context: ContentContext,
  bookId: string,
  reply: FastifyReply,
): Promise<unknown> {
  const found = await bookById(db, context, bookId)
  if ('status' in found) {
    return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
  }
  const dtos = await buildBookDtos(db, [found.row], context.user.id)
  return dtos[0]
}

interface ReadProgressUpdate {
  page?: number
  completed?: boolean
  readDate?: string | null
  deviceId?: string | null
  deviceName?: string | null
  locator?: string | null
}

async function upsertReadProgress(
  db: Kysely<DB>,
  userId: string,
  bookId: string,
  update: ReadProgressUpdate,
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await db
    .selectFrom('read_progress')
    .selectAll()
    .where('user_id', '=', userId)
    .where('book_id', '=', bookId)
    .executeTakeFirst()

  if (!existing) {
    await db
      .insertInto('read_progress')
      .values({
        user_id: userId,
        book_id: bookId,
        page: update.page ?? 0,
        completed: update.completed === true ? 1 : 0,
        read_date: update.readDate ?? null,
        device_id: update.deviceId ?? null,
        device_name: update.deviceName ?? null,
        locator: update.locator ?? null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    return
  }

  const values: Record<string, unknown> = { last_modified_date: now }
  if (update.page !== undefined) values.page = update.page
  if (update.completed !== undefined) values.completed = update.completed ? 1 : 0
  if (update.readDate !== undefined) values.read_date = update.readDate
  if (update.deviceId !== undefined) values.device_id = update.deviceId
  if (update.deviceName !== undefined) values.device_name = update.deviceName
  if (update.locator !== undefined) values.locator = update.locator

  await db
    .updateTable('read_progress')
    .set(values as never)
    .where('user_id', '=', userId)
    .where('book_id', '=', bookId)
    .execute()
}

/**
 * Recompute the aggregation of the series a book belongs to.
 *
 * A series' `booksMetadata` is made of its books' metadata, so anything that
 * changes a book's metadata changes it. Returns the series id, or null when there
 * is no such book.
 */
async function aggregateSeriesOfBook(db: Kysely<DB>, bookId: string): Promise<string | null> {
  const book = await db.selectFrom('books').select('series_id').where('id', '=', bookId).executeTakeFirst()
  if (!book) return null
  await aggregateSeriesMetadata(db, book.series_id)
  return book.series_id
}

export async function registerBookRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  /**
   * Import files that are somewhere on the server into series.
   *
   * Accepted and queued, one job a file, as the reference does: each file is
   * answered for by a `BookImported` event when its turn has come, which is what
   * the Import page waits for. A row that cannot be a job is passed over.
   */
  app.post('/api/v1/books/import', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { books?: unknown; copyMode?: unknown }
    const copyMode = COPY_MODES.find((mode) => mode === body.copyMode)
    if (copyMode === undefined) {
      return reply.code(400).send({ validationErrors: { copyMode: `must be one of ${COPY_MODES.join(', ')}` } })
    }

    const books = Array.isArray(body.books) ? (body.books as Record<string, unknown>[]) : []
    const jobs = books
      .filter((book) => typeof book?.sourceFile === 'string' && typeof book.seriesId === 'string')
      .map((book) => ({
        type: 'ImportBook',
        uniqueKey: `IMPORT_BOOK_${String(book.sourceFile)}`,
        priority: JOB_PRIORITY.HIGHEST,
        payload: {
          sourceFile: book.sourceFile,
          seriesId: book.seriesId,
          copyMode,
          destinationName: typeof book.destinationName === 'string' ? book.destinationName : null,
          upgradeBookId: typeof book.upgradeBookId === 'string' ? book.upgradeBookId : null,
        },
      }))
    await enqueueJobs(db, jobs)
    return reply.code(202).send()
  })

  const list = async (req: FastifyRequest, body: Record<string, unknown>, reply: FastifyReply) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true

    const term = searchTerm(query, body)

    // A search ranks by how well each book matches, unless the caller asked for an
    // order of their own - which is what the reference does too. A term with nothing
    // searchable in it has nothing to rank by.
    const relevance = term === undefined ? null : relevanceSort(INDEXES.BOOKS, term)
    const allowed = bookSorts(context.user.id, requiredValue(body.condition, 'readListId'))
    const sorts = parseSort(
      query.sort,
      relevance === null ? allowed : { ...allowed, relevance },
      relevance === null ? BOOK_DEFAULT_SORT : [{ column: relevance, direction: 'asc' }],
    )

    const filters: BookQueryFilters = {
      libraryIds: scopedLibraryIds(context, query.library_id),
      mediaStatuses: toArray(query.media_status),
      readStatuses: toArray(query.read_status),
      tags: toArray(query.tag),
      search: term,
      deleted: booleanParam(query.deleted),
    }
    if (typeof query.released_after === 'string') filters.releasedAfter = query.released_after

    if (body.condition !== undefined) {
      const translated = bookCondition(body.condition, { userId: context.user.id })
      if ('error' in translated) return reply.code(400).send({ message: translated.error })
      filters.condition = translated.filter
    }

    const { rows, total } = await findBooks(db, context, filters, sorts, page, size, unpaged)
    const dtos = await buildBookDtos(db, rows, context.user.id)
    return springPage(dtos, page, effectiveSize(total, size, unpaged), total)
  }

  app.get('/api/v1/books', { preHandler: requireAuth }, async (req, reply) => list(req, {}, reply))

  app.post('/api/v1/books/list', { preHandler: requireAuth }, async (req, reply) =>
    list(req, (req.body ?? {}) as Record<string, unknown>, reply),
  )

  app.get('/api/v1/books/latest', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true
    const filters: BookQueryFilters = { libraryIds: context.libraryIds }
    const sorts: SortSpec[] = [{ column: 'books.created_date', direction: 'desc' }]
    const { rows, total } = await findBooks(db, context, filters, sorts, page, size, unpaged)
    const dtos = await buildBookDtos(db, rows, context.user.id)
    return springPage(dtos, page, effectiveSize(total, size, unpaged), total)
  })

  app.get('/api/v1/books/ondeck', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const libraryIds = scopedLibraryIds(context, query.library_id)
    if (libraryIds.length === 0) return springPage([], page, size, 0)

    const userId = context.user.id
    // One book per series the caller has read something of and is not in the
    // middle of: the first one they have not read yet, with series ordered by how
    // recently they were read. A series with a book in progress is left out, as
    // the reference leaves it out - that book is already under "keep reading".
    const rows = await db
      .selectFrom('books')
      .select(['books.id', 'books.series_id'])
      .where('books.library_id', 'in', libraryIds)
      .where('books.deleted_date', 'is', null)
      .where(
        sql<boolean>`books.series_id in (
          select distinct rp_books.series_id
          from read_progress rp
          join books rp_books on rp_books.id = rp.book_id
          where rp.user_id = ${userId} and rp.completed = 1
        )`,
      )
      .where(
        sql<boolean>`books.series_id not in (
          select distinct rp_books.series_id
          from read_progress rp
          join books rp_books on rp_books.id = rp.book_id
          where rp.user_id = ${userId} and rp.completed = 0 and rp_books.deleted_date is null
        )`,
      )
      .where(
        sql<boolean>`books.id in (
          select ranked.id from (
            select b2.id,
                   row_number() over (
                     partition by b2.series_id
                     order by coalesce(m2.number_sort, b2.number) asc, b2.id asc
                   ) as rn
            from books b2
            left join book_metadata m2 on m2.book_id = b2.id
            where b2.deleted_date is null
              and b2.series_id in (
                select distinct rp_books.series_id
                from read_progress rp
                join books rp_books on rp_books.id = rp.book_id
                where rp.user_id = ${userId} and rp.completed = 1
              )
              and b2.id not in (select book_id from read_progress where user_id = ${userId} and completed = 1)
          ) ranked where ranked.rn = 1
        )`,
      )
      .orderBy(
        sql<number>`(
          select max(rp2.read_date)
          from read_progress rp2
          join books b3 on b3.id = rp2.book_id
          where b3.series_id = books.series_id and rp2.user_id = ${userId}
        )`,
        'desc',
      )
      .orderBy('books.id')
      .execute()

    let candidates = rows
    const allowed = allowedSeries(context)
    if (allowed !== null) candidates = candidates.filter((row) => allowed.has(row.series_id))

    const total = candidates.length
    const window = candidates.slice(page * size, page * size + size)
    const bookRows = await loadBookRows(
      db,
      window.map((row) => row.id),
    )
    return springPage(await buildBookDtos(db, bookRows, context.user.id), page, size, total)
  })

  app.get('/api/v1/books/duplicates', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    if (context.libraryIds.length === 0) return springPage([], page, size, 0)

    const rows = await db
      .selectFrom('books')
      .select(['books.id', 'books.series_id'])
      .where('books.library_id', 'in', context.libraryIds)
      .where('books.deleted_date', 'is', null)
      .where('books.file_hash', 'is not', null)
      .where(
        sql<boolean>`books.file_hash in (
          select file_hash from books
          where file_hash is not null and deleted_date is null
          group by file_hash having count(*) > 1
        )`,
      )
      .orderBy('books.file_hash')
      .orderBy('books.id')
      .execute()

    let candidates = rows
    const allowed = allowedSeries(context)
    if (allowed !== null) candidates = candidates.filter((row) => allowed.has(row.series_id))

    const total = candidates.length
    const window = candidates.slice(page * size, page * size + size)
    const bookRows = await loadBookRows(
      db,
      window.map((row) => row.id),
    )
    return springPage(await buildBookDtos(db, bookRows, context.user.id), page, size, total)
  })

  app.get<{ Params: { bookId: string } }>('/api/v1/books/:bookId', { preHandler: requireAuth }, async (req, reply) => {
    const context = await contentContext(db, req)
    return sendBook(db, context, req.params.bookId, reply)
  })

  /** Adjacent book in the same series, in reading order. */
  const sibling = (path: string, direction: 'next' | 'previous') => {
    app.get<{ Params: { bookId: string } }>(path, { preHandler: requireAuth }, async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const meta = await db
        .selectFrom('book_metadata')
        .select(['number_sort'])
        .where('book_id', '=', found.row.id)
        .executeTakeFirst()
      const current = meta?.number_sort ?? 0

      const comparison = direction === 'next' ? '>' : '<'
      const order = direction === 'next' ? 'asc' : 'desc'
      const row = await db
        .selectFrom('books')
        .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
        .select('books.id')
        .where('books.series_id', '=', found.row.series_id)
        .where('books.deleted_date', 'is', null)
        .where(
          sql<boolean>`(book_metadata.number_sort ${sql.raw(comparison)} ${current}
            or (book_metadata.number_sort = ${current} and books.id ${sql.raw(comparison)} ${found.row.id}))`,
        )
        .orderBy(sql`book_metadata.number_sort ${sql.raw(order)}`)
        .orderBy(sql`books.id ${sql.raw(order)}`)
        .limit(1)
        .executeTakeFirst()

      if (!row) return reply.code(404).send({ message: 'No such book' })
      return sendBook(db, context, row.id, reply)
    })
  }

  sibling('/api/v1/books/:bookId/next', 'next')
  sibling('/api/v1/books/:bookId/previous', 'previous')

  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/readlists',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const rows = await db
        .selectFrom('readlist_book')
        .innerJoin('readlists', 'readlists.id', 'readlist_book.readlist_id')
        .selectAll('readlists')
        .where('readlist_book.book_id', '=', req.params.bookId)
        .orderBy('readlists.name')
        .execute()

      const readlistIds = rows.map((row) => row.id)
      const contents = await db
        .selectFrom('readlist_book')
        .select(['readlist_id', 'book_id'])
        .where('readlist_id', 'in', readlistIds)
        .orderBy('number')
        .execute()

      const booksByReadList = new Map<string, string[]>()
      for (const entry of contents) {
        const list = booksByReadList.get(entry.readlist_id)
        if (list) list.push(entry.book_id)
        else booksByReadList.set(entry.readlist_id, [entry.book_id])
      }

      return rows.map((row) => toReadListDto(row as unknown as ReadListRow, booksByReadList.get(row.id) ?? []))
    },
  )

  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/positions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const row = await db
        .selectFrom('epub_positions')
        .select('positions')
        .where('book_id', '=', req.params.bookId)
        .executeTakeFirst()
      const positions = row ? parseJsonArray(row.positions) : []
      return { positions, total: positions.length }
    },
  )

  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/progression',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const progress = await db
        .selectFrom('read_progress')
        .selectAll()
        .where('user_id', '=', context.user.id)
        .where('book_id', '=', req.params.bookId)
        .executeTakeFirst()

      const stored = progress?.locator ? parseJsonObject(progress.locator) : null
      return {
        device: { id: progress?.device_id ?? '', name: progress?.device_name ?? '' },
        locator: stored ?? defaultLocator(found.row),
        // When the reader was there, which is what the next progression is compared
        // with - not when the row was last written.
        modified: progress?.read_date ?? progress?.last_modified_date ?? found.row.created_date,
      }
    },
  )

  app.put<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/progression',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const body = (req.body ?? {}) as { device?: unknown; locator?: unknown; modified?: unknown }
      const device = (body.device ?? {}) as { id?: unknown; name?: unknown }

      // A progression says when the reader was there. Two devices reading one book
      // each send theirs, and the one that was read on last is the one to keep: a
      // device coming back online with yesterday's place must not undo today's.
      const modified = typeof body.modified === 'string' ? new Date(body.modified) : null
      const readAt = modified !== null && !Number.isNaN(modified.getTime()) ? modified : null
      if (readAt !== null) {
        const stored = await db
          .selectFrom('read_progress')
          .select('read_date')
          .where('book_id', '=', req.params.bookId)
          .where('user_id', '=', context.user.id)
          .executeTakeFirst()
        if (stored?.read_date && readAt.getTime() <= new Date(stored.read_date).getTime()) {
          return reply.code(409).send({ message: 'Progression is older than existing' })
        }
      }

      // Where the reader is says how far through the book they are, once the book
      // has been analysed and there is something to measure against. Until then
      // the locator is kept as it came.
      let derived: LocatorProgress | null = null
      const media = await db
        .selectFrom('media')
        .select(['status', 'media_type', 'page_count'])
        .where('book_id', '=', req.params.bookId)
        .executeTakeFirst()
      if (media?.status === 'READY' && media.page_count > 0 && isRecord(body.locator)) {
        try {
          if (profileFor(media.media_type) === 'EPUB') {
            const stored = await db
              .selectFrom('epub_positions')
              .select('positions')
              .where('book_id', '=', req.params.bookId)
              .executeTakeFirst()
            const positions = (stored ? parseJsonArray(stored.positions) : []) as StoredPosition[]
            derived = epubProgress(body.locator, positions, media.page_count)
          } else {
            derived = pagedProgress(body.locator, media.page_count)
          }
        } catch (error) {
          if (error instanceof ProgressionError) return reply.code(400).send({ message: error.message })
          throw error
        }
      }

      await upsertReadProgress(db, context.user.id, req.params.bookId, {
        ...(derived === null ? {} : { page: derived.page, completed: derived.completed }),
        locator:
          derived !== null
            ? JSON.stringify(derived.locator)
            : body.locator === undefined
              ? null
              : JSON.stringify(body.locator),
        deviceId: typeof device.id === 'string' ? device.id : null,
        deviceName: typeof device.name === 'string' ? device.name : null,
        readDate: (readAt ?? new Date()).toISOString(),
      })
      // Progress is private to the reader, but it also moves the series' read
      // counts, which everyone the event reaches may be looking at.
      opts.events.publish({
        name: 'ReadProgressChanged',
        data: { bookId: req.params.bookId, userId: context.user.id },
        userId: context.user.id,
      })
      opts.events.publish({
        name: 'ReadProgressSeriesChanged',
        data: { seriesId: found.row.series_id, userId: context.user.id },
        userId: context.user.id,
      })
      return reply.code(204).send()
    },
  )

  app.patch<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/read-progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      const body = (req.body ?? {}) as { page?: unknown; completed?: unknown }
      const media = await db
        .selectFrom('media')
        .select('page_count')
        .where('book_id', '=', req.params.bookId)
        .executeTakeFirst()
      const pageCount = media?.page_count ?? 0

      // The reference's rules: a book said to be completed is at its last page
      // whatever page came with it, and otherwise the page decides - it has to be
      // a page of the book, and reaching the last one completes the book. Either
      // way the reader has just read, and the date says so.
      const update: ReadProgressUpdate = { readDate: new Date().toISOString() }
      if (body.completed === true) {
        update.page = pageCount
        update.completed = true
      } else {
        if (typeof body.page !== 'number' || !Number.isInteger(body.page)) {
          return reply.code(400).send({ message: 'page must be specified if completed is false or unspecified' })
        }
        if (body.page < 1 || body.page > pageCount) {
          return reply
            .code(400)
            .send({ message: `Page argument (${body.page}) must be within 1 and book page count (${pageCount})` })
        }
        update.page = body.page
        update.completed = body.page === pageCount
      }

      await upsertReadProgress(db, context.user.id, req.params.bookId, update)
      opts.events.publish({
        name: 'ReadProgressChanged',
        data: { bookId: req.params.bookId, userId: context.user.id },
        userId: context.user.id,
      })
      opts.events.publish({
        name: 'ReadProgressSeriesChanged',
        data: { seriesId: found.row.series_id, userId: context.user.id },
        userId: context.user.id,
      })
      return reply.code(204).send()
    },
  )

  app.delete<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/read-progress',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await bookById(db, context, req.params.bookId)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Book not found' : 'Forbidden' })
      }

      await db
        .deleteFrom('read_progress')
        .where('user_id', '=', context.user.id)
        .where('book_id', '=', req.params.bookId)
        .execute()
      opts.events.publish({
        name: 'ReadProgressDeleted',
        data: { bookId: req.params.bookId, userId: context.user.id },
        userId: context.user.id,
      })
      opts.events.publish({
        name: 'ReadProgressSeriesDeleted',
        data: { seriesId: found.row.series_id, userId: context.user.id },
        userId: context.user.id,
      })
      return reply.code(204).send()
    },
  )

  app.patch<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/metadata',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('book_metadata')
        .select('book_id')
        .where('book_id', '=', req.params.bookId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Book not found' })

      const result = await applyBookMetadataPatch(db, req.params.bookId, (req.body ?? {}) as Record<string, unknown>)
      if (!result.ok) return reply.code(400).send({ validationErrors: result.errors })

      // A series' booksMetadata is made of its books' metadata, so a hand edit
      // changes it too - the reference schedules the same work after this route.
      const seriesId = await aggregateSeriesOfBook(db, req.params.bookId)
      const changed = await bookRef(db, req.params.bookId)
      if (changed) announceBook(opts.events, 'BookChanged', changed)
      if (seriesId !== null) {
        const series = await seriesRef(db, seriesId)
        if (series) announceSeries(opts.events, 'SeriesChanged', series)
      }
      return reply.code(204).send()
    },
  )

  /** Bulk metadata update, keyed by book id - used by the UI's bulk edit screen. */
  app.patch('/api/v1/books/metadata', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const errors: Record<string, string> = {}
    const editedBooks: string[] = []

    for (const [bookId, update] of Object.entries(body)) {
      if (typeof update !== 'object' || update === null) {
        errors[bookId] = 'must be an object'
        continue
      }
      const existing = await db
        .selectFrom('book_metadata')
        .select('book_id')
        .where('book_id', '=', bookId)
        .executeTakeFirst()
      if (!existing) {
        errors[bookId] = 'book not found'
        continue
      }
      const result = await applyBookMetadataPatch(db, bookId, update as Record<string, unknown>)
      if (!result.ok) {
        for (const [field, message] of Object.entries(result.errors)) errors[`${bookId}.${field}`] = message
      }
      editedBooks.push(bookId)
    }

    if (Object.keys(errors).length > 0) return reply.code(400).send({ validationErrors: errors })

    // One aggregation per series, however many of its books were edited.
    const series = new Set<string>()
    for (const bookId of editedBooks) {
      const seriesId = await aggregateSeriesOfBook(db, bookId)
      if (seriesId !== null) series.add(seriesId)

      const changed = await bookRef(db, bookId)
      if (changed) announceBook(opts.events, 'BookChanged', changed)
    }

    for (const seriesId of series) {
      const ref = await seriesRef(db, seriesId)
      if (ref) announceSeries(opts.events, 'SeriesChanged', ref)
    }
    return reply.code(200).send()
  })

  app.post<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/analyze',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db.selectFrom('books').select('id').where('id', '=', req.params.bookId).executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Book not found' })

      await enqueueJob(db, {
        type: 'AnalyzeBook',
        uniqueKey: `ANALYZE_BOOK_${req.params.bookId}`,
        priority: JOB_PRIORITY.HIGH,
        payload: { bookId: req.params.bookId },
      })
      return reply.code(202).send()
    },
  )

  app.post<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/metadata/refresh',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db.selectFrom('books').select('id').where('id', '=', req.params.bookId).executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Book not found' })

      await enqueueJob(db, {
        type: 'RefreshBookMetadata',
        uniqueKey: `REFRESH_BOOK_METADATA_${req.params.bookId}`,
        priority: JOB_PRIORITY.HIGH,
        payload: { bookId: req.params.bookId },
      })
      // A cover beside the book is refreshed with the metadata, as the reference's
      // endpoint does.
      await enqueueJob(db, {
        type: 'RefreshBookLocalArtwork',
        uniqueKey: `REFRESH_BOOK_LOCAL_ARTWORK_${req.params.bookId}`,
        priority: JOB_PRIORITY.HIGH,
        payload: { bookId: req.params.bookId },
      })
      return reply.code(202).send()
    },
  )
}

/** Spring reports a page size equal to the element count when it is unpaged. */
function effectiveSize(total: number, size: number, unpaged: boolean): number {
  return unpaged ? total : size
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Starting locator for a book nobody has opened.
 *
 * The reader treats this as "at the very beginning"; it mirrors the shape of a
 * stored locator so clients only ever parse one structure.
 */
function defaultLocator(book: BookRow): Record<string, unknown> {
  return {
    href: `/${book.id}`,
    type: 'application/vnd.comicbook+zip',
    title: book.name,
    locations: { position: 1, progression: 0, totalProgression: 0 },
  }
}
