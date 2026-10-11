import { sql, type Kysely } from 'kysely'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { buildBookDtos } from './content-data.js'
import type { BookRow } from './content-dto.js'
import { contentContext, type ContentContext } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { applyBookMetadataPatch } from './metadata.js'
import { toReadListDto, type ReadListRow } from './organisation-dto.js'
import { applySort, booleanParam, likeAny, paging, parseSort, toArray, type SortSpec } from './query.js'

/**
 * Book browsing, metadata, progression and progress.
 *
 * Visibility follows the series the book belongs to: there is no per-book
 * restriction in Komga, and a book whose series the caller may not see is
 * reported as forbidden rather than missing.
 */

const BOOK_SORTS: Record<string, string> = {
  name: 'books.name',
  number: 'books.number',
  url: 'books.url',
  created: 'books.created_date',
  lastModified: 'books.last_modified_date',
  'metadata.title': 'book_metadata.title',
  'metadata.numberSort': 'book_metadata.number_sort',
  'metadata.releaseDate': 'book_metadata.release_date',
}

const BOOK_DEFAULT_SORT: SortSpec[] = [
  { column: 'book_metadata.number_sort', direction: 'asc' },
  { column: 'books.id', direction: 'asc' },
]

export interface BookQueryFilters {
  libraryIds: string[]
  seriesId?: string
  search?: string
  mediaStatuses?: string[]
  readStatuses?: string[]
  tags?: string[]
  releasedAfter?: string
  unpaged?: boolean | null
  deleted?: boolean | null
}

/** Base query with every join the filters and sorts can need. */
function bookQuery(db: Kysely<DB>, filters: BookQueryFilters) {
  let query = db
    .selectFrom('books')
    .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
    .innerJoin('series', 'series.id', 'books.series_id')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'series.id')
    .leftJoin('media', 'media.book_id', 'books.id')

  query = query.where('books.library_id', 'in', filters.libraryIds)
  query =
    filters.deleted === true
      ? query.where('books.deleted_date', 'is not', null)
      : query.where('books.deleted_date', 'is', null)

  if (filters.seriesId !== undefined) query = query.where('books.series_id', '=', filters.seriesId)

  if (filters.search !== undefined && filters.search !== '') {
    const term = filters.search
    query = query.where((eb) =>
      eb.or([
        likeAny('book_metadata.title', term),
        likeAny('books.name', term),
        likeAny('series_metadata.title', term),
      ]),
    )
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

  if (filters.unpaged === true) {
    query = query.where((eb) => eb.or([eb('media.page_count', '=', 0), eb('media.page_count', 'is', null)]))
  } else if (filters.unpaged === false) {
    query = query.where('media.page_count', '>', 0)
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

  const statuses = filters.readStatuses ?? []
  const needsPostFilter = context.restrictedSeriesIds !== null || statuses.length > 0

  if (!needsPostFilter) {
    const counted = await bookQuery(db, filters)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow()
    const total = Number(counted.total)

    let idsQuery = applySort(bookQuery(db, filters).select('books.id'), sorts).orderBy('books.id')
    if (!unpaged) idsQuery = idsQuery.limit(size).offset(page * size)
    const ids = (await idsQuery.execute()).map((row) => row.id)
    return { rows: await loadBookRows(db, ids), total }
  }

  const ordered = await applySort(bookQuery(db, filters).select(['books.id', 'books.series_id']), sorts)
    .orderBy('books.id')
    .execute()

  let candidates = ordered
  if (context.restrictedSeriesIds !== null) {
    const allowed = new Set(context.restrictedSeriesIds)
    candidates = candidates.filter((row) => allowed.has(row.series_id))
  }

  if (statuses.length > 0) {
    const status = await loadReadStatus(db, context.user.id)
    candidates = candidates.filter((row) => matchesReadStatus(status, statuses, row.id))
  }

  const total = candidates.length
  const window = unpaged ? candidates : candidates.slice(page * size, page * size + size)
  return {
    rows: await loadBookRows(
      db,
      window.map((row) => row.id),
    ),
    total,
  }
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
  if (context.restrictedSeriesIds !== null && !context.restrictedSeriesIds.includes(book.series_id)) {
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

export async function registerBookRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const list = async (req: FastifyRequest, body: Record<string, unknown>) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true
    const sorts = parseSort(query.sort, BOOK_SORTS, BOOK_DEFAULT_SORT)

    const filters: BookQueryFilters = {
      libraryIds: toArray(query.library_id).length > 0 ? toArray(query.library_id) : context.libraryIds,
      mediaStatuses: toArray(query.media_status),
      readStatuses: toArray(query.read_status),
      tags: toArray(query.tag),
      search: searchTerm(query, body),
      unpaged: booleanParam(query.unpaged),
      deleted: booleanParam(query.deleted),
    }
    if (typeof query.released_after === 'string') filters.releasedAfter = query.released_after

    const { rows, total } = await findBooks(db, context, filters, sorts, page, size, unpaged)
    const dtos = await buildBookDtos(db, rows, context.user.id)
    return springPage(dtos, page, effectiveSize(total, size, unpaged), total)
  }

  app.get('/api/v1/books', { preHandler: requireAuth }, async (req) => list(req, {}))

  app.post('/api/v1/books/list', { preHandler: requireAuth }, async (req) =>
    list(req, (req.body ?? {}) as Record<string, unknown>),
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
    const libraryIds = toArray(query.library_id).length > 0 ? toArray(query.library_id) : context.libraryIds
    if (libraryIds.length === 0) return springPage([], page, size, 0)

    const userId = context.user.id
    // One book per series the caller has started: the first one they have not
    // read yet, with series ordered by how recently they were read.
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
        sql<boolean>`books.id in (
          select ranked.id from (
            select b2.id,
                   row_number() over (partition by b2.series_id order by b2.number asc, b2.id asc) as rn
            from books b2
            where b2.deleted_date is null
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
    if (context.restrictedSeriesIds !== null) {
      const allowed = new Set(context.restrictedSeriesIds)
      candidates = candidates.filter((row) => allowed.has(row.series_id))
    }

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
    if (context.restrictedSeriesIds !== null) {
      const allowed = new Set(context.restrictedSeriesIds)
      candidates = candidates.filter((row) => allowed.has(row.series_id))
    }

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
        modified: progress?.last_modified_date ?? found.row.created_date,
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

      const body = (req.body ?? {}) as { device?: unknown; locator?: unknown }
      const device = (body.device ?? {}) as { id?: unknown; name?: unknown }
      await upsertReadProgress(db, context.user.id, req.params.bookId, {
        locator: body.locator === undefined ? null : JSON.stringify(body.locator),
        deviceId: typeof device.id === 'string' ? device.id : null,
        deviceName: typeof device.name === 'string' ? device.name : null,
        readDate: new Date().toISOString(),
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
      const update: ReadProgressUpdate = {}
      if (typeof body.page === 'number' && Number.isFinite(body.page)) update.page = Math.max(0, Math.trunc(body.page))
      if (body.completed === true) {
        update.completed = true
        update.readDate = new Date().toISOString()
      } else if (body.completed === false) {
        update.completed = false
        update.readDate = null
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
      return reply.code(204).send()
    },
  )

  /** Bulk metadata update, keyed by book id - used by the UI's bulk edit screen. */
  app.patch('/api/v1/books/metadata', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const errors: Record<string, string> = {}

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
    }

    if (Object.keys(errors).length > 0) return reply.code(400).send({ validationErrors: errors })
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
      return reply.code(202).send()
    },
  )
}

/** Spring reports a page size equal to the element count when it is unpaged. */
function effectiveSize(total: number, size: number, unpaged: boolean): number {
  return unpaged ? total : size
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
