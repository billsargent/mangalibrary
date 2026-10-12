/**
 * Duplicate pages: the hashes somebody has judged, the ones nobody has, and the
 * pages each of them matches.
 *
 * Every route here is administrative, as they are in the reference: what is listed
 * names files on disk and what a removal does rewrites them.
 *
 * What is stored is one row per judged hash - its action, its size, how many times
 * pages with it have been deleted - and the page hashes themselves live on
 * `media_page`, so a match is one indexed lookup rather than a copy that has to be
 * kept in step. See `docs/COMPATIBILITY.md`.
 */

import type { FastifyInstance } from 'fastify'
import { sql, type RawBuilder } from 'kysely'

import { requireAdmin } from '../auth/session.js'
import { bookFilePath, findBookRecord } from '../content/files.js'
import { openBook } from '../media/index.js'
import { queuePageRemoval, type PageToRemove } from '../media/removePages.js'
import { resizedImage } from '../thumbnails/image.js'
import type { RouteOptions } from './libraries.js'
import { springPage } from './dto.js'
import { applySort, paging, parseSort, toArray } from './query.js'

/** The actions a hash can be given, as the contract names them. */
const ACTIONS = ['DELETE_AUTO', 'DELETE_MANUAL', 'IGNORE'] as const
type Action = (typeof ACTIONS)[number]

/** The size the reference resizes the first match to when it learns a new hash. */
const KNOWN_THUMBNAIL_MAX_EDGE = 500

/** Sortable properties, as the contract names them, and the default order. */
const KNOWN_SORT: Record<string, string | RawBuilder<unknown>> = {
  hash: 'ph.hash',
  matchCount: sql`count(p.file_hash)`,
  deleteCount: 'ph.delete_count',
  deleteSize: sql`ph.size * ph.delete_count`,
  fileSize: 'ph.size',
  size: 'ph.size',
  createdDate: 'ph.created_date',
  created: 'ph.created_date',
  lastModifiedDate: 'ph.last_modified_date',
  lastModified: 'ph.last_modified_date',
}

const UNKNOWN_SORT: Record<string, string | RawBuilder<unknown>> = {
  hash: 'p.file_hash',
  fileSize: sql`max(p.file_size)`,
  size: sql`max(p.file_size)`,
  matchCount: sql`count(p.book_id)`,
  totalSize: sql`count(p.book_id) * max(p.file_size)`,
}

const MATCH_SORT: Record<string, string | RawBuilder<unknown>> = {
  url: 'b.url',
  bookId: 'p.book_id',
  pageNumber: 'p.number',
}

/**
 * A hash to look at, and a reason when it cannot be one.
 *
 * A hash is a string the API is addressed by, and the reference rejects a request
 * that names something else; being told which value was wrong is more use than an
 * empty list.
 */
interface HashParameter {
  pageHash: string
}

/** Read the `action` query parameter, refusing a name that is not an action. */
function readActions(query: unknown): { actions: Action[] | null } | { error: string } {
  const values = toArray((query as { action?: unknown }).action)
  const actions: Action[] = []
  for (const value of values) {
    const action = ACTIONS.find((candidate) => candidate === value)
    if (action === undefined) return { error: `action must be one of ${ACTIONS.join(', ')}` }
    actions.push(action)
  }
  return { actions: actions.length > 0 ? actions : null }
}

/** What a known hash looks like to a client, as the contract shapes it. */
interface KnownDto {
  hash: string
  size: number | null
  action: string
  deleteCount: number
  matchCount: number
  created: string
  lastModified: string
}

/** A hash nobody has judged, and how many pages carry it. */
interface UnknownDto {
  hash: string
  size: number | null
  matchCount: number
}

/** One page that carries a hash, and the book it is in. */
interface MatchDto {
  bookId: string
  url: string
  pageNumber: number
  fileName: string
  fileSize: number
  mediaType: string
}

export async function registerPageHashRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const db = opts.db

  /** The hash of one page, with the book and the page it is on, or null. */
  async function firstMatch(hash: string): Promise<{ bookId: string; pageNumber: number } | null> {
    const row = await db
      .selectFrom('media_page')
      .select(['book_id', 'number'])
      .where('file_hash', '=', hash)
      .orderBy('book_id')
      .orderBy('number')
      .executeTakeFirst()

    return row ? { bookId: row.book_id, pageNumber: row.number } : null
  }

  /** The bytes of a page, and the type they are in, or null when it cannot be read. */
  async function pageBytes(bookId: string, pageNumber: number): Promise<{ bytes: Buffer; mediaType: string } | null> {
    const record = await findBookRecord(db, bookId)
    if (record === null) return null

    const path = await bookFilePath(record)
    if (path === null) return null

    const book = await openBook(path)
    try {
      const page = book.pages[pageNumber - 1]
      if (page === undefined) return null
      return { bytes: await book.readPage(pageNumber), mediaType: page.mediaType }
    } catch {
      return null
    } finally {
      book.close()
    }
  }

  app.get('/api/v1/page-hashes', { preHandler: requireAdmin }, async (req, reply) => {
    const filter = readActions(req.query)
    if ('error' in filter) return reply.code(400).send({ message: filter.error })

    const { page, size } = paging(req.query)
    const sorts = parseSort((req.query as { sort?: unknown }).sort, KNOWN_SORT, [
      { column: 'ph.hash', direction: 'asc' },
    ] as const)

    const grouped = db
      .selectFrom('page_hash as ph')
      .leftJoin('media_page as p', 'p.file_hash', 'ph.hash')
      .select([
        'ph.hash',
        'ph.size',
        'ph.action',
        'ph.delete_count',
        'ph.created_date',
        'ph.last_modified_date',
        sql<number>`count(p.file_hash)`.as('match_count'),
      ])
      .groupBy(['ph.hash', 'ph.size', 'ph.action', 'ph.delete_count', 'ph.created_date', 'ph.last_modified_date'])
      .$if(filter.actions !== null, (query) => query.where('ph.action', 'in', filter.actions ?? []))

    const total = await db
      .selectFrom(grouped.as('grouped'))
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirstOrThrow()

    const rows = await applySort(grouped, sorts)
      .limit(size)
      .offset(page * size)
      .execute()

    const content: KnownDto[] = rows.map((row) => ({
      hash: row.hash,
      size: row.size,
      action: row.action,
      deleteCount: row.delete_count,
      matchCount: Number(row.match_count),
      created: row.created_date,
      lastModified: row.last_modified_date,
    }))

    return springPage(content, page, size, Number(total.count))
  })

  app.get('/api/v1/page-hashes/unknown', { preHandler: requireAdmin }, async (req) => {
    const { page, size } = paging(req.query)
    const sorts = parseSort((req.query as { sort?: unknown }).sort, UNKNOWN_SORT, [
      { column: 'p.file_hash', direction: 'asc' },
    ] as const)

    const grouped = db
      .selectFrom('media_page as p')
      .select([
        'p.file_hash as hash',
        sql<number>`max(p.file_size)`.as('size'),
        sql<number>`count(p.book_id)`.as('match_count'),
      ])
      .where('p.file_hash', '!=', '')
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('page_hash as ph').select('ph.hash').whereRef('ph.hash', '=', 'p.file_hash'))),
      )
      .groupBy('p.file_hash')
      .having(sql<number>`count(p.book_id)`, '>', 1)

    const total = await db
      .selectFrom(grouped.as('grouped'))
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirstOrThrow()

    const rows = await applySort(grouped, sorts)
      .limit(size)
      .offset(page * size)
      .execute()

    const content: UnknownDto[] = rows.map((row) => ({
      hash: row.hash,
      size: row.size,
      matchCount: Number(row.match_count),
    }))

    return springPage(content, page, size, Number(total.count))
  })

  app.get<{ Params: HashParameter }>('/api/v1/page-hashes/:pageHash', { preHandler: requireAdmin }, async (req) => {
    const hash = req.params.pageHash
    const { page, size } = paging(req.query)
    const sorts = parseSort((req.query as { sort?: unknown }).sort, MATCH_SORT, [
      { column: 'p.book_id', direction: 'asc' },
      { column: 'p.number', direction: 'asc' },
    ] as const)

    const query = db
      .selectFrom('media_page as p')
      .leftJoin('books as b', 'b.id', 'p.book_id')
      .select(['p.book_id', 'b.url', 'p.number', 'p.file_name', 'p.file_size', 'p.media_type'])
      .where('p.file_hash', '=', hash)

    const total = await db
      .selectFrom(query.as('matches'))
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirstOrThrow()

    const rows = await applySort(query, sorts)
      .limit(size)
      .offset(page * size)
      .execute()

    const content: MatchDto[] = rows.map((row) => ({
      bookId: row.book_id,
      url: row.url ?? '',
      pageNumber: row.number,
      fileName: row.file_name,
      fileSize: row.file_size ?? 0,
      mediaType: row.media_type,
    }))

    return springPage(content, page, size, Number(total.count))
  })

  app.get<{ Params: HashParameter }>(
    '/api/v1/page-hashes/:pageHash/thumbnail',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const thumbnail = await db
        .selectFrom('page_hash_thumbnail')
        .select('thumbnail')
        .where('hash', '=', req.params.pageHash)
        .executeTakeFirst()

      if (!thumbnail?.thumbnail) return reply.code(404).send({ message: 'Thumbnail not found' })
      return reply.header('cache-control', 'private, max-age=60').type('image/jpeg').send(thumbnail.thumbnail)
    },
  )

  app.get<{ Params: HashParameter }>(
    '/api/v1/page-hashes/unknown/:pageHash/thumbnail',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const match = await firstMatch(req.params.pageHash)
      if (match === null) return reply.code(404).send({ message: 'Thumbnail not found' })

      const page = await pageBytes(match.bookId, match.pageNumber)
      if (page === null) return reply.code(404).send({ message: 'Thumbnail not found' })

      const resize = Number.parseInt(String((req.query as { resize?: unknown }).resize ?? ''), 10)
      if (!Number.isFinite(resize)) {
        return reply.header('cache-control', 'private, max-age=60').type(page.mediaType).send(page.bytes)
      }

      // A resize is always a JPEG, as the reference converts it.
      const image = await resizedImage(page.bytes, page.mediaType, resize)
      if (image === null) return reply.code(404).send({ message: 'Thumbnail not found' })
      return reply.header('cache-control', 'private, max-age=60').type(image.mediaType).send(image.bytes)
    },
  )

  /** Every page carrying a hash, as a page to remove, grouped by the book it is in. */
  async function matchesOf(hash: string): Promise<Map<string, PageToRemove[]>> {
    const rows = await db
      .selectFrom('media_page')
      .select(['book_id', 'number', 'file_name', 'media_type', 'file_hash', 'file_size'])
      .where('file_hash', '=', hash)
      .orderBy('book_id')
      .orderBy('number')
      .execute()

    const byBook = new Map<string, PageToRemove[]>()
    for (const row of rows) {
      const pages = byBook.get(row.book_id) ?? []
      pages.push({
        fileName: row.file_name,
        mediaType: row.media_type,
        fileHash: row.file_hash,
        fileSize: row.file_size,
        pageNumber: row.number,
      })
      byBook.set(row.book_id, pages)
    }

    return byBook
  }

  app.post<{ Params: HashParameter }>(
    '/api/v1/page-hashes/:pageHash/delete-all',
    { preHandler: requireAdmin },
    async (req, reply) => {
      // Every page carrying the hash goes, in every book that has one. Each book is a
      // job of its own, because a book is rewritten once and never twice at a time.
      for (const [bookId, pages] of await matchesOf(req.params.pageHash)) {
        await queuePageRemoval(db, bookId, pages)
      }
      return reply.code(202).send()
    },
  )

  app.post<{ Params: HashParameter }>(
    '/api/v1/page-hashes/:pageHash/delete-match',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = (req.body ?? {}) as { bookId?: unknown; pageNumber?: unknown; fileName?: unknown }
      const bookId = typeof body.bookId === 'string' ? body.bookId : ''
      const fileName = typeof body.fileName === 'string' ? body.fileName : ''
      const pageNumber = typeof body.pageNumber === 'number' ? body.pageNumber : Number.NaN
      if (bookId === '' || fileName === '' || !Number.isInteger(pageNumber)) {
        return reply.code(400).send({ message: 'bookId, pageNumber and fileName are required' })
      }

      // A match that names a page the hash does not carry is not one to remove, and
      // is refused here rather than queued and skipped later.
      const matched = (await matchesOf(req.params.pageHash)).get(bookId) ?? []
      const page = matched.find((candidate) => candidate.pageNumber === pageNumber && candidate.fileName === fileName)
      if (page === undefined) return reply.code(400).send({ message: 'that page does not carry this hash' })

      await queuePageRemoval(db, bookId, [page])
      return reply.code(202).send()
    },
  )

  app.put('/api/v1/page-hashes', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { hash?: unknown; size?: unknown; action?: unknown }
    const hash = typeof body.hash === 'string' ? body.hash.trim() : ''
    if (hash === '') return reply.code(400).send({ message: 'hash must not be blank' })

    const action = ACTIONS.find((candidate) => candidate === body.action)
    if (action === undefined) return reply.code(400).send({ message: `action must be one of ${ACTIONS.join(', ')}` })

    let size: number | null = null
    if (body.size !== undefined && body.size !== null) {
      if (typeof body.size !== 'number' || !Number.isFinite(body.size)) {
        return reply.code(400).send({ message: 'size must be a number' })
      }
      // A negative size is the same as no size, as the reference normalises it.
      size = body.size < 0 ? null : body.size
    }

    const existing = await db.selectFrom('page_hash').select('hash').where('hash', '=', hash).executeTakeFirst()

    const now = new Date().toISOString()
    // Kysely answers `undefined` when there is no row, which is what a hash nobody
    // has judged looks like.
    if (existing !== undefined) {
      await db
        .updateTable('page_hash')
        .set({ action, size, last_modified_date: now })
        .where('hash', '=', hash)
        .execute()
      return reply.code(202).send()
    }

    await db
      .insertInto('page_hash')
      .values({ hash, size, action, created_date: now, last_modified_date: now })
      .execute()

    // A known hash keeps a picture of one of its pages, which is what a browser
    // shows before somebody decides what to do with it. A hash with no match yet
    // simply has none.
    const match = await firstMatch(hash)
    if (match !== null) {
      const page = await pageBytes(match.bookId, match.pageNumber)
      if (page !== null) {
        const image = await resizedImage(page.bytes, page.mediaType, KNOWN_THUMBNAIL_MAX_EDGE)
        if (image !== null) {
          await db
            .insertInto('page_hash_thumbnail')
            .values({ hash, thumbnail: image.bytes })
            .onConflict((oc) => oc.column('hash').doUpdateSet({ thumbnail: image.bytes }))
            .execute()
        }
      }
    }

    return reply.code(202).send()
  })
}
