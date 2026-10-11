import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireRole } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { insideRoot } from '../media/scan.js'
import { humanSize } from './content-dto.js'
import { contentContext, seriesAllowed, type ContentContext } from './context.js'
import type { RouteOptions } from './libraries.js'

/**
 * Media: the page list of a book, downloading a book's file, and the jobs that
 * remove or regenerate derived data.
 *
 * Reading a page *image* means opening the archive or PDF, which the media layer
 * owns; those endpoints (`pages/{n}`, the manifests, `resource/{resource}`,
 * `file/*`) arrive with it. Everything here works from the database or from the
 * file already on disk.
 */

/** Content type for a download, by extension. */
const FILE_MEDIA_TYPES: Record<string, string> = {
  '.cbz': 'application/vnd.comicbook+zip',
  '.zip': 'application/vnd.comicbook+zip',
  '.cbr': 'application/vnd.comicbook-rar',
  '.rar': 'application/vnd.comicbook-rar',
  '.cb7': 'application/x-cb7',
  '.7z': 'application/x-cb7',
  '.cbt': 'application/x-cbt',
  '.tar': 'application/x-cbt',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.kepub': 'application/kepub+zip',
}

interface BookRecord {
  libraryId: string
  seriesId: string
  name: string
  /** Where the row says the file is: an absolute `file:` URL, or a relative path. */
  url: string
  /** The library root, as configured. */
  root: string
}

/** The book as stored, without touching the filesystem. */
async function findBook(db: Kysely<DB>, bookId: string): Promise<BookRecord | null> {
  const row = await db
    .selectFrom('books')
    .innerJoin('libraries', 'libraries.id', 'books.library_id')
    .select(['books.url', 'books.name', 'books.library_id', 'books.series_id', 'libraries.root'])
    .where('books.id', '=', bookId)
    .executeTakeFirst()
  if (!row) return null

  return {
    libraryId: row.library_id,
    seriesId: row.series_id,
    name: row.name,
    url: row.url,
    root: row.root,
  }
}

/**
 * Paths a stored location could mean, most specific first.
 *
 * Komga stores absolute `file:` URLs - the importer copies them across
 * unchanged - while a row written by hand or by a future scanner may hold a path
 * relative to the library root. Both are accepted so that a migrated library and
 * a freshly scanned one behave the same way.
 */
function storedPathCandidates(root: string, url: string): string[] {
  const candidates: string[] = []
  if (url.startsWith('file:')) {
    try {
      candidates.push(fileURLToPath(url))
    } catch {
      // Not a usable file URL; the relative interpretation below may still work.
    }
  } else if (isAbsolute(url)) {
    candidates.push(url)
  }
  candidates.push(resolve(root, url))
  return candidates
}

/**
 * The book's file on disk, or null.
 *
 * Every candidate is confined to the library root, so a row can never point the
 * server at an arbitrary file - including one that arrives from an imported
 * database.
 */
async function bookFile(record: BookRecord): Promise<string | null> {
  for (const candidate of storedPathCandidates(record.root, record.url)) {
    if (!insideRoot(record.root, candidate)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isFile()) return candidate
  }
  return null
}

function bookAccess(context: ContentContext, book: BookRecord): boolean {
  return seriesAllowed(context, book.seriesId, book.libraryId)
}

export async function registerMediaRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  /** Pages of a book, in reading order. */
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/pages',
    { preHandler: requireRole('PAGE_STREAMING') },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const book = await findBook(db, req.params.bookId)
      if (!book) return reply.code(404).send({ message: 'Book not found' })
      if (!bookAccess(context, book)) return reply.code(403).send({ message: 'Forbidden' })

      const rows = await db
        .selectFrom('media_page')
        .selectAll()
        .where('book_id', '=', req.params.bookId)
        .orderBy('number')
        .execute()

      return rows.map((row) => ({
        number: row.number,
        fileName: row.file_name,
        mediaType: row.media_type,
        width: row.width,
        height: row.height,
        sizeBytes: row.file_size,
        size: row.file_size === null ? '' : humanSize(row.file_size),
      }))
    },
  )

  /** Download the book file itself. */
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/file',
    { preHandler: requireRole('FILE_DOWNLOAD') },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const book = await findBook(db, req.params.bookId)
      if (!book) return reply.code(404).send({ message: 'Book not found' })
      if (!bookAccess(context, book)) return reply.code(403).send({ message: 'Forbidden' })

      const path = await bookFile(book)
      if (!path) return reply.code(404).send({ message: 'Book file not found' })
      const info = await stat(path)

      const fileName = basename(path).replace(/"/g, "'")
      return reply
        .header('content-length', info.size)
        .header(
          'content-disposition',
          `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .header('last-modified', info.mtime.toUTCString())
        .type(FILE_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
        .send(createReadStream(path))
    },
  )

  /**
   * Delete a book's file.
   *
   * Queued rather than done inline: removing files is the scanning layer's job
   * (it also has to keep the database and the trash in step).
   */
  app.delete<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/file',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db.selectFrom('books').select('id').where('id', '=', req.params.bookId).executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Book not found' })

      await enqueueJob(db, {
        type: 'DeleteBookFile',
        uniqueKey: `DELETE_BOOK_FILE_${req.params.bookId}`,
        priority: JOB_PRIORITY.LOW,
        payload: { bookId: req.params.bookId },
      })
      return reply.code(202).send()
    },
  )

  app.delete<{ Params: { seriesId: string } }>(
    '/api/v1/series/:seriesId/file',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('series')
        .select('id')
        .where('id', '=', req.params.seriesId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Series not found' })

      await enqueueJob(db, {
        type: 'DeleteSeriesFile',
        uniqueKey: `DELETE_SERIES_FILE_${req.params.seriesId}`,
        priority: JOB_PRIORITY.LOW,
        payload: { seriesId: req.params.seriesId },
      })
      return reply.code(202).send()
    },
  )

  /**
   * Regenerate posters for books that have none, or that have one smaller than
   * the book's first page.
   */
  app.put('/api/v1/books/thumbnails', { preHandler: requireAdmin }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>
    await enqueueJob(db, {
      type: 'RegenerateBookThumbnails',
      uniqueKey: 'REGENERATE_BOOK_THUMBNAILS',
      priority: JOB_PRIORITY.LOW,
      payload: { forBiggerResultOnly: String(query.for_bigger_result_only) === 'true' },
    })
    return reply.code(202).send()
  })
}
