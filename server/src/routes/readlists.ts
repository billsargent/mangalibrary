import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth, requireRole } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { nextTsid } from '../tsid.js'
import { zipStream } from '../zip.js'
import { archiveEntries } from './book-files.js'
import { buildBookDtos } from './content-data.js'
import type { BookRow } from './content-dto.js'
import { loadReadStatus, matchesReadStatus, sendBook } from './books.js'
import { accessibleSeriesIds, contentContext, type ContentContext } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { toReadListDto, type ReadListDto, type ReadListRow } from './organisation-dto.js'
import { applySort, booleanParam, likeAny, paging, parseSort, toArray, type SortSpec } from './query.js'

/**
 * Read lists: named, ordered collections of books.
 *
 * Like collections, read lists are global and their visibility is derived from
 * their members: a read list is listed when at least one of its books is visible,
 * and `bookIds` is trimmed to the visible ones.
 */

const READ_LIST_SORTS: Record<string, string> = {
  name: 'readlists.name',
  created: 'readlists.created_date',
  lastModified: 'readlists.last_modified_date',
}

const READ_LIST_DEFAULT_SORT: SortSpec[] = [{ column: 'readlists.name', direction: 'asc' }]

const READ_LIST_COLUMNS = [
  'readlists.id',
  'readlists.name',
  'readlists.summary',
  'readlists.ordered',
  'readlists.created_date',
  'readlists.last_modified_date',
] as const

/** Book membership per read list, in stored order, trimmed to what is visible. */
async function booksByReadList(
  db: Kysely<DB>,
  readListIds: readonly string[],
  allowed: Set<string> | null,
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>()
  if (readListIds.length === 0) return grouped

  const rows = await db
    .selectFrom('readlist_book')
    .innerJoin('books', 'books.id', 'readlist_book.book_id')
    .select(['readlist_book.readlist_id', 'readlist_book.book_id', 'books.series_id'])
    .where('readlist_book.readlist_id', 'in', readListIds)
    .orderBy('readlist_book.number')
    .execute()

  for (const row of rows) {
    if (allowed !== null && !allowed.has(row.series_id)) continue
    const list = grouped.get(row.readlist_id)
    if (list) list.push(row.book_id)
    else grouped.set(row.readlist_id, [row.book_id])
  }
  return grouped
}

async function unknownBooks(db: Kysely<DB>, bookIds: readonly string[]): Promise<string[]> {
  if (bookIds.length === 0) return []
  const rows = await db.selectFrom('books').select('id').where('id', 'in', bookIds).execute()
  const known = new Set(rows.map((row) => row.id))
  return bookIds.filter((id) => !known.has(id))
}

async function replaceMembership(db: Kysely<DB>, readListId: string, bookIds: readonly string[]): Promise<void> {
  await db.deleteFrom('readlist_book').where('readlist_id', '=', readListId).execute()
  if (bookIds.length === 0) return
  await db
    .insertInto('readlist_book')
    .values(bookIds.map((bookId, index) => ({ readlist_id: readListId, book_id: bookId, number: index })))
    .execute()
}

function readMembers(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.bookIds)) return null
  const ids = body.bookIds.map((value) => (typeof value === 'string' ? value.trim() : '')).filter((id) => id !== '')
  return [...new Set(ids)]
}

// ---------------------------------------------------------------------------
// ComicRack `.cbl` matching
// ---------------------------------------------------------------------------

interface RequestedBook {
  series: string
  number: string
}

interface ComicRackReadList {
  name: string
  books: RequestedBook[]
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity.startsWith('#x') || entity.startsWith('#X')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    found[match[1]!.toLowerCase()] = decodeEntities(match[2]!)
  }
  return found
}

/**
 * Read a ComicRack reading list.
 *
 * A `.cbl` is a fixed, tiny subset of XML - a title and a flat list of books -
 * so it is parsed directly rather than by taking on an XML dependency. Anything
 * that is not a reading list at all is rejected.
 */
function parseComicRackReadList(xml: string): ComicRackReadList | null {
  const nameMatch = /<Name>([\s\S]*?)<\/Name>/i.exec(xml)
  if (!nameMatch) return null

  const books: RequestedBook[] = []
  for (const match of xml.matchAll(/<Book\b([^>]*)>/gi)) {
    const attrs = attributes(match[1] ?? '')
    const series = (attrs.series ?? '').trim()
    if (series === '') continue
    books.push({ series, number: (attrs.number ?? '').trim() })
  }

  return { name: decodeEntities(nameMatch[1]!).trim(), books }
}

/** Series whose title matches a reading list entry, ignoring case. */
async function matchingSeries(db: Kysely<DB>, requested: string): Promise<{ id: string; title: string }[]> {
  const rows = await db
    .selectFrom('series')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'series.id')
    .select(['series.id', 'series_metadata.title', 'series.name'])
    .where(
      sql<boolean>`lower(series_metadata.title) = lower(${requested})
      or lower(series.name) = lower(${requested})`,
    )
    .execute()
  return rows.map((row) => ({ id: row.id, title: row.title }))
}

interface BookMatchSeriesDto {
  seriesId: string
  title: string
  releaseDate: string | null
}

interface BookMatchBookDto {
  bookId: string
  title: string
  number: string
}

async function matchRequest(
  db: Kysely<DB>,
  allowed: Set<string> | null,
  requested: RequestedBook,
): Promise<{ series: BookMatchSeriesDto; books: BookMatchBookDto[] }[]> {
  const candidates = await matchingSeries(db, requested.series)
  if (candidates.length === 0) return []

  const matches: { series: BookMatchSeriesDto; books: BookMatchBookDto[] }[] = []
  for (const candidate of candidates) {
    if (allowed !== null && !allowed.has(candidate.id)) continue

    let booksQuery = db
      .selectFrom('books')
      .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
      .select(['books.id', 'book_metadata.title', 'book_metadata.number'])
      .where('books.series_id', '=', candidate.id)
      .where('books.deleted_date', 'is', null)
    if (requested.number !== '') booksQuery = booksQuery.where('book_metadata.number', '=', requested.number)

    const books = await booksQuery.orderBy('book_metadata.number_sort').execute()
    const release = await db
      .selectFrom('book_metadata_aggregation')
      .select('release_date')
      .where('series_id', '=', candidate.id)
      .executeTakeFirst()

    matches.push({
      series: { seriesId: candidate.id, title: candidate.title, releaseDate: release?.release_date ?? null },
      books: books.map((book) => ({ bookId: book.id, title: book.title, number: book.number })),
    })
  }
  return matches
}

export async function registerReadListRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const loadOne = async (
    context: ContentContext,
    id: string,
  ): Promise<{ dto: ReadListDto } | { status: 403 | 404 }> => {
    const row = await db.selectFrom('readlists').select(READ_LIST_COLUMNS).where('id', '=', id).executeTakeFirst()
    if (!row) return { status: 404 }

    const allowed = await accessibleSeriesIds(db, context)
    const grouped = await booksByReadList(db, [id], allowed)
    const members = grouped.get(id) ?? []
    if (allowed !== null && members.length === 0) return { status: 403 }

    return { dto: toReadListDto(row as unknown as ReadListRow, members) }
  }

  app.get('/api/v1/readlists', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true
    const libraries = toArray(query.library_id)
    const scoped = libraries.length > 0 ? libraries : context.libraryIds

    let builder = db.selectFrom('readlists').select(READ_LIST_COLUMNS)
    if (typeof query.search === 'string' && query.search !== '') {
      builder = builder.where(likeAny('readlists.name', query.search))
    }
    if (scoped.length > 0) {
      builder = builder.where((eb) =>
        eb.exists(
          eb
            .selectFrom('readlist_book')
            .innerJoin('books', 'books.id', 'readlist_book.book_id')
            .select(sql<number>`1`.as('one'))
            .whereRef('readlist_book.readlist_id', '=', 'readlists.id')
            .where('books.library_id', 'in', scoped),
        ),
      )
    }

    const sorts = parseSort(query.sort, READ_LIST_SORTS, READ_LIST_DEFAULT_SORT)
    const rows = await applySort(builder, sorts).orderBy('readlists.id').execute()

    const allowed = await accessibleSeriesIds(db, context)
    const grouped = await booksByReadList(
      db,
      rows.map((row) => row.id),
      allowed,
    )
    const visibleRows = rows
      .map((row) => ({ row, members: grouped.get(row.id) ?? [] }))
      .filter((entry) => allowed === null || entry.members.length > 0)

    const total = visibleRows.length
    const window = unpaged ? visibleRows : visibleRows.slice(page * size, page * size + size)
    const content = window.map((entry) => toReadListDto(entry.row as unknown as ReadListRow, entry.members))
    return springPage(content, page, unpaged ? total : size, total)
  })

  app.post('/api/v1/readlists', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') return reply.code(400).send({ validationErrors: { name: 'must not be blank' } })

    const bookIds = readMembers(body) ?? []
    const missing = await unknownBooks(db, bookIds)
    if (missing.length > 0) {
      return reply.code(400).send({ validationErrors: { bookIds: `unknown books: ${missing.join(', ')}` } })
    }

    const now = new Date().toISOString()
    const id = nextTsid()
    await db
      .insertInto('readlists')
      .values({
        id,
        name,
        summary: typeof body.summary === 'string' ? body.summary : '',
        ordered: body.ordered === false ? 0 : 1,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await replaceMembership(db, id, bookIds)

    const row = await db
      .selectFrom('readlists')
      .select(READ_LIST_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return toReadListDto(row as unknown as ReadListRow, bookIds)
  })

  app.post('/api/v1/readlists/match/comicrack', { preHandler: requireAdmin }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ message: 'A ComicRack file upload is required' })

    const upload = await req.file()
    if (!upload) return reply.code(400).send({ message: 'A ComicRack file upload is required' })

    const parsed = parseComicRackReadList((await upload.toBuffer()).toString('utf8'))
    if (!parsed) return reply.code(400).send({ message: 'Not a ComicRack reading list' })

    const context = await contentContext(db, req)
    const allowed = await accessibleSeriesIds(db, context)

    const requests = []
    for (const requested of parsed.books) {
      requests.push({
        request: { series: [requested.series], number: requested.number },
        matches: await matchRequest(db, allowed, requested),
      })
    }

    return {
      errorCode: '',
      readListMatch: { name: parsed.name, errorCode: '' },
      requests,
    }
  })

  app.get<{ Params: { id: string } }>('/api/v1/readlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const context = await contentContext(db, req)
    const found = await loadOne(context, req.params.id)
    if ('status' in found) {
      return reply.code(found.status).send({ message: found.status === 404 ? 'Read list not found' : 'Forbidden' })
    }
    return found.dto
  })

  app.patch<{ Params: { id: string } }>('/api/v1/readlists/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await db.selectFrom('readlists').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'Read list not found' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const values: Record<string, unknown> = { last_modified_date: new Date().toISOString() }

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return reply.code(400).send({ validationErrors: { name: 'must not be blank' } })
      values.name = name
    }
    if ('summary' in body) {
      if (typeof body.summary !== 'string') {
        return reply.code(400).send({ validationErrors: { summary: 'must be a string' } })
      }
      values.summary = body.summary
    }
    if ('ordered' in body) {
      if (typeof body.ordered !== 'boolean') {
        return reply.code(400).send({ validationErrors: { ordered: 'must be a boolean' } })
      }
      values.ordered = body.ordered ? 1 : 0
    }

    const members = readMembers(body)
    if (members !== null) {
      const missing = await unknownBooks(db, members)
      if (missing.length > 0) {
        return reply.code(400).send({ validationErrors: { bookIds: `unknown books: ${missing.join(', ')}` } })
      }
    }

    await db
      .updateTable('readlists')
      .set(values as never)
      .where('id', '=', req.params.id)
      .execute()
    if (members !== null) await replaceMembership(db, req.params.id, members)
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/api/v1/readlists/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await db.selectFrom('readlists').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'Read list not found' })

    await db.deleteFrom('readlists').where('id', '=', req.params.id).execute()
    return reply.code(204).send()
  })

  /** Books of a read list, in read list order, with the documented filters. */
  app.get<{ Params: { id: string } }>(
    '/api/v1/readlists/:id/books',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await loadOne(context, req.params.id)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Read list not found' : 'Forbidden' })
      }

      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, size } = paging(query)
      const unpaged = booleanParam(query.unpaged) === true
      const ordered = await accessibleBooks(db, context, req.params.id)

      const passing = await structuralFilter(
        db,
        ordered.map((book) => book.id),
        query,
      )
      let candidates = ordered.filter((book) => passing.has(book.id))

      const statuses = toArray(query.read_status)
      if (statuses.length > 0) {
        const readStatus = await loadReadStatus(db, context.user.id)
        candidates = candidates.filter((book) => matchesReadStatus(readStatus, statuses, book.id))
      }

      const total = candidates.length
      const window = unpaged ? candidates : candidates.slice(page * size, page * size + size)
      const rows = await loadBooks(
        db,
        window.map((book) => book.id),
      )
      const dtos = await buildBookDtos(db, rows, context.user.id)
      return springPage(dtos, page, unpaged ? total : size, total)
    },
  )

  /** Neighbouring book within the read list. */
  const sibling = (path: string, direction: 'next' | 'previous') => {
    app.get<{ Params: { id: string; bookId: string } }>(path, { preHandler: requireAuth }, async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await loadOne(context, req.params.id)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Read list not found' : 'Forbidden' })
      }

      const ordered = await accessibleBooks(db, context, req.params.id)
      const index = ordered.findIndex((book) => book.id === req.params.bookId)
      if (index === -1) return reply.code(404).send({ message: 'Book not found in read list' })

      const neighbour = ordered[direction === 'next' ? index + 1 : index - 1]
      if (!neighbour) return reply.code(404).send({ message: 'No such book' })

      return sendBook(db, context, neighbour.id, reply)
    })
  }

  sibling('/api/v1/readlists/:id/books/:bookId/next', 'next')
  sibling('/api/v1/readlists/:id/books/:bookId/previous', 'previous')

  /**
   * Download a whole read list as a ZIP.
   *
   * Entries are numbered in read list order and carry the book's file name, so
   * the archive keeps the reading order the list defines. A book whose file is no
   * longer on disk is skipped rather than failing the whole download.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/readlists/:id/file',
    { preHandler: requireRole('FILE_DOWNLOAD') },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await loadOne(context, req.params.id)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Read list not found' : 'Forbidden' })
      }

      const ordered = await accessibleBooks(db, context, req.params.id)
      const entries = await archiveEntries(
        db,
        ordered.map((book) => book.id),
        (fileName, index) => `${index + 1} - ${fileName}`,
      )
      const fileName = `${found.dto.name}.zip`.replace(/"/g, "'")
      return reply
        .header(
          'content-disposition',
          `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .type('application/zip')
        .send(zipStream(entries))
    },
  )
}

interface OrderedBook {
  id: string
}

/** Books of a read list the caller may see, in read list order. */
async function accessibleBooks(db: Kysely<DB>, context: ContentContext, readListId: string): Promise<OrderedBook[]> {
  const allowed = await accessibleSeriesIds(db, context)
  const grouped = await booksByReadList(db, [readListId], allowed)
  return (grouped.get(readListId) ?? []).map((id) => ({ id }))
}

/** Which of `bookIds` survive the structural filters, by id. */
async function structuralFilter(
  db: Kysely<DB>,
  bookIds: readonly string[],
  query: Record<string, unknown>,
): Promise<Set<string>> {
  if (bookIds.length === 0) return new Set()

  let builder = db
    .selectFrom('books')
    .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
    .leftJoin('media', 'media.book_id', 'books.id')
    .select('books.id')
    .where('books.id', 'in', bookIds)

  const libraries = toArray(query.library_id)
  if (libraries.length > 0) builder = builder.where('books.library_id', 'in', libraries)

  builder =
    booleanParam(query.deleted) === true
      ? builder.where('books.deleted_date', 'is not', null)
      : builder.where('books.deleted_date', 'is', null)

  const mediaStatuses = toArray(query.media_status)
  if (mediaStatuses.length > 0) builder = builder.where('media.status', 'in', mediaStatuses)
  if (booleanParam(query.unpaged) === true) {
    builder = builder.where((eb) => eb.or([eb('media.page_count', '=', 0), eb('media.page_count', 'is', null)]))
  }

  const tags = toArray(query.tag)
  if (tags.length > 0) {
    builder = builder.where((eb) =>
      eb.exists(
        eb
          .selectFrom('book_metadata_tag')
          .select(sql<number>`1`.as('one'))
          .whereRef('book_metadata_tag.book_id', '=', 'books.id')
          .where('book_metadata_tag.tag', 'in', tags),
      ),
    )
  }

  const authors = toArray(query.author)
  if (authors.length > 0) {
    builder = builder.where((eb) =>
      eb.exists(
        eb
          .selectFrom('book_metadata_author')
          .select(sql<number>`1`.as('one'))
          .whereRef('book_metadata_author.book_id', '=', 'books.id')
          .where('book_metadata_author.name', 'in', authors),
      ),
    )
  }

  const rows = await builder.execute()
  return new Set(rows.map((row) => row.id))
}

async function loadBooks(db: Kysely<DB>, ids: readonly string[]): Promise<BookRow[]> {
  if (ids.length === 0) return []
  const rows = await db.selectFrom('books').selectAll().where('id', 'in', ids).execute()
  const byId = new Map(rows.map((row) => [row.id, row as unknown as BookRow]))
  return ids.map((id) => byId.get(id)).filter((row): row is BookRow => row !== undefined)
}
