import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { type Kysely } from 'kysely'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import sharp from 'sharp'
import { requireAdmin, requireRole } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { openBook } from '../media/index.js'
import { mediaTypeFor, profileFor } from '../media/kinds.js'
import { bookFilePath, findBookRecord, type BookFileRecord } from '../books/files.js'
import { cacheHeaders, isNotModified } from './cache-headers.js'
import { humanSize } from './content-dto.js'
import { contentContext, seriesAllowed, type ContentContext } from './context.js'
import type { RouteOptions } from './libraries.js'

/**
 * Media: the page list of a book, the image of a page, a book's own resources,
 * downloading a book's file, and the jobs that remove or regenerate derived data.
 *
 * A page image and a resource are read by opening the archive or PDF, which the
 * media layer owns. The series and read list archives that build on them are the
 * sibling route groups.
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

function bookAccess(context: ContentContext, book: BookFileRecord): boolean {
  return seriesAllowed(context, book.seriesId, book.libraryId)
}

/** File extension for an image, for the inline `Content-Disposition`. */
const PAGE_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpeg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/jxl': '.jxl',
}

/** A page thumbnail is resized to this many pixels on its longest edge. */
const PAGE_THUMBNAIL_SIZE = 300

/**
 * Extensions a book's own fonts can carry.
 *
 * A reader loads a font from inside a book with no session to send, so a font is
 * served without credentials; anything else needs one.
 */
const FONT_EXTENSIONS = ['otf', 'woff', 'woff2', 'eot', 'ttf', 'svg']

/** A document loaded from inside a book must not be able to run script. */
const RESOURCE_CSP = "script-src 'none'; object-src 'none';"

interface PageMeta {
  book: BookFileRecord
  lastModified: Date
  pageNumber: number
  /** The page's own media type, before any conversion. */
  mediaType: string
}

/**
 * Resolve a book, its analysed media and one of its pages.
 *
 * Both page routes agree on what counts as missing, unanalysed, out of range or
 * not streamable because it lives here: a page image is only served for a book
 * this server can render one for - a ZIP or RAR of images, which the reference
 * calls the Divina profile, or a PDF - so a text EPUB's markup is refused rather
 * than sent as something a reader cannot show.
 */
async function pageFor(
  db: Kysely<DB>,
  req: FastifyRequest,
  bookId: string,
  rawPageNumber: string,
  zeroBased: boolean,
): Promise<{ code: number; message: string } | PageMeta> {
  const context = await contentContext(db, req)
  const book = await findBookRecord(db, bookId)
  if (!book) return { code: 404, message: 'Book not found' }
  if (!bookAccess(context, book)) return { code: 403, message: 'Forbidden' }

  const media = await db
    .selectFrom('media')
    .select(['status', 'media_type', 'last_modified_date'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (!media || media.status !== 'READY') return { code: 404, message: 'Book analysis failed' }

  const profile = profileFor(media.media_type)
  if (profile === null) return { code: 404, message: 'Book analysis failed' }

  const requested = Number.parseInt(rawPageNumber, 10)
  const pageNumber = (Number.isInteger(requested) ? requested : 0) + (zeroBased ? 1 : 0)
  const page = await db
    .selectFrom('media_page')
    .select('media_type')
    .where('book_id', '=', bookId)
    .where('number', '=', pageNumber)
    .executeTakeFirst()
  if (!page) return { code: 400, message: 'Page number does not exist' }

  // A text EPUB's pages are markup, and there is no image to render for them.
  if (profile === 'EPUB' && !page.media_type.startsWith('image/')) {
    return { code: 404, message: 'Book format is not supported' }
  }

  return { book, lastModified: new Date(media.last_modified_date), pageNumber, mediaType: page.media_type }
}

/** Read one page out of a book's file, reporting what a reader can act on. */
async function readPage(
  book: BookFileRecord,
  pageNumber: number,
): Promise<{ code: number; message: string } | { bytes: Buffer }> {
  const path = await bookFilePath(book)
  if (!path) return { code: 404, message: 'File not found, it may have moved' }

  let contents
  try {
    contents = await openBook(path)
  } catch {
    return { code: 404, message: 'File not found, it may have moved' }
  }
  try {
    return { bytes: await contents.readPage(pageNumber) }
  } catch {
    return { code: 400, message: 'Page number does not exist' }
  } finally {
    contents.close()
  }
}

/** Re-encode an image to JPEG or PNG, or null when it cannot be read. */
async function convertImage(bytes: Buffer, target: string): Promise<Buffer | null> {
  try {
    const image = sharp(bytes)
    if (target === 'image/jpeg') return await image.flatten({ background: '#ffffff' }).jpeg().toBuffer()
    return await image.png().toBuffer()
  } catch {
    return null
  }
}

/** Shrink an image to fit inside a square, without enlarging it. */
async function resizeImage(bytes: Buffer, mediaType: string, size: number): Promise<Buffer | null> {
  try {
    const metadata = await sharp(bytes).metadata()
    const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0)
    // A JPEG that already fits is served as it is, as the reference does.
    if (mediaType === 'image/jpeg' && longest > 0 && longest <= size) return bytes

    const target = Math.min(longest > 0 ? longest : size, size)
    return await sharp(bytes).resize(target, target, { fit: 'inside' }).jpeg().toBuffer()
  } catch {
    return null
  }
}

export async function registerMediaRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  /** Pages of a book, in reading order. */
  app.get<{ Params: { bookId: string } }>(
    '/api/v1/books/:bookId/pages',
    { preHandler: requireRole('PAGE_STREAMING') },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const book = await findBookRecord(db, req.params.bookId)
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

  /**
   * The image of one page.
   *
   * `zero_based` shifts the page number the way the reference's reader asks for
   * it, and `convert` re-encodes the image when a client cannot read the stored
   * format. The response is an inline attachment named after the book and page,
   * so saving it produces a file that sorts with the rest of the book.
   */
  app.get<{
    Params: { bookId: string; pageNumber: string }
    Querystring: { convert?: string; zero_based?: string }
  }>('/api/v1/books/:bookId/pages/:pageNumber', { preHandler: requireRole('PAGE_STREAMING') }, async (req, reply) => {
    const resolved = await pageFor(db, req, req.params.bookId, req.params.pageNumber, req.query.zero_based === 'true')
    if ('code' in resolved) return reply.code(resolved.code).send({ message: resolved.message })
    const { book, lastModified, pageNumber, mediaType } = resolved

    if (isNotModified(req, lastModified)) return reply.headers(cacheHeaders(lastModified)).code(304).send()

    const convertTo = req.query.convert?.toLowerCase()
    if (convertTo !== undefined && convertTo !== '' && convertTo !== 'jpeg' && convertTo !== 'png') {
      return reply.code(400).send({ message: `Invalid conversion format: ${req.query.convert}` })
    }

    const page = await readPage(book, pageNumber)
    if ('code' in page) return reply.code(page.code).send({ message: page.message })

    let bytes = page.bytes
    let type = mediaType
    if (convertTo === 'jpeg' || convertTo === 'png') {
      const target = convertTo === 'jpeg' ? 'image/jpeg' : 'image/png'
      if (type !== target) {
        const converted = await convertImage(bytes, target)
        if (converted === null) return reply.code(404).send({ message: 'Image conversion failed' })
        bytes = converted
        type = target
      }
    }

    const fileName = `${book.name}-${pageNumber}${PAGE_IMAGE_EXTENSIONS[type] ?? ''}`.replace(/"/g, "'")
    return reply
      .headers(cacheHeaders(lastModified))
      .header('content-disposition', `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .type(type || 'application/octet-stream')
      .send(bytes)
  })

  /** The image of one page, resized to a thumbnail, always as JPEG. */
  app.get<{ Params: { bookId: string; pageNumber: string } }>(
    '/api/v1/books/:bookId/pages/:pageNumber/thumbnail',
    { preHandler: requireRole('PAGE_STREAMING') },
    async (req, reply) => {
      const resolved = await pageFor(db, req, req.params.bookId, req.params.pageNumber, false)
      if ('code' in resolved) return reply.code(resolved.code).send({ message: resolved.message })
      const { book, lastModified, pageNumber, mediaType } = resolved

      if (isNotModified(req, lastModified)) return reply.headers(cacheHeaders(lastModified)).code(304).send()

      const page = await readPage(book, pageNumber)
      if ('code' in page) return reply.code(page.code).send({ message: page.message })

      const thumbnail = await resizeImage(page.bytes, mediaType, PAGE_THUMBNAIL_SIZE)
      if (thumbnail === null) return reply.code(404).send({ message: 'Image conversion failed' })

      return reply.headers(cacheHeaders(lastModified)).type('image/jpeg').send(thumbnail)
    },
  )

  /**
   * A file from inside a book, addressed by its path within the book.
   *
   * This is how a reader loads the parts of an EPUB - its stylesheets, images and
   * chapters - so it is the EPUB profile only. A font is served without
   * credentials, because the reader fetches it from inside a book where it has no
   * session to send; everything else requires one, and is confined by the same
   * access rules as the book itself.
   */
  app.get<{ Params: { bookId: string; '*': string } }>('/api/v1/books/:bookId/resource/*', async (req, reply) => {
    const resourceName = (req.params['*'] ?? '').replace(/^\/+/, '')
    const extension = resourceName.split('.').pop()?.toLowerCase() ?? ''
    const isFont = FONT_EXTENSIONS.includes(extension)
    if (!isFont && !req.user) return reply.code(401).send({ message: 'Unauthorized' })

    const book = await findBookRecord(db, req.params.bookId)
    if (!book) return reply.code(404).send({ message: 'Book not found' })

    const media = await db
      .selectFrom('media')
      .select(['status', 'media_type', 'last_modified_date'])
      .where('book_id', '=', req.params.bookId)
      .executeTakeFirst()
    if (!media || media.status !== 'READY') return reply.code(404).send({ message: 'Book analysis failed' })

    const lastModified = new Date(media.last_modified_date)
    const headers = { ...cacheHeaders(lastModified), 'content-security-policy': RESOURCE_CSP }
    if (isNotModified(req, lastModified)) return reply.headers(headers).code(304).send()

    if (profileFor(media.media_type) !== 'EPUB') {
      return reply
        .code(400)
        .send({ message: `Book media type '${media.media_type ?? ''}' not compatible with requested profile` })
    }

    if (!isFont) {
      const context = await contentContext(db, req)
      if (!bookAccess(context, book)) return reply.code(403).send({ message: 'Forbidden' })
    }

    const known = await db
      .selectFrom('media_file')
      .select('file_name')
      .where('book_id', '=', req.params.bookId)
      .where('file_name', '=', resourceName)
      .executeTakeFirst()
    if (!known) return reply.code(404).send({ message: 'Resource not found' })

    const path = await bookFilePath(book)
    if (!path) return reply.code(404).send({ message: 'File not found, it may have moved' })

    let contents
    try {
      contents = await openBook(path)
    } catch {
      return reply.code(404).send({ message: 'File not found, it may have moved' })
    }

    try {
      const bytes = await contents.readResource(resourceName)
      const fileName = (resourceName.split('/').pop() ?? resourceName).replace(/"/g, "'")
      return reply
        .headers(headers)
        .header(
          'content-disposition',
          `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .type(mediaTypeFor(resourceName))
        .send(bytes)
    } catch {
      return reply.code(404).send({ message: 'Resource not found' })
    } finally {
      contents.close()
    }
  })

  /**
   * Download the book file itself.
   *
   * The reference also answers on `file/*`, where a client may append a file name
   * of its own choosing; the path after `file/` is ignored and the book's own file
   * is sent either way.
   */
  const downloadBookFile = async (
    req: FastifyRequest<{ Params: { bookId: string; '*'?: string } }>,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const context = await contentContext(db, req)
    const book = await findBookRecord(db, req.params.bookId)
    if (!book) return reply.code(404).send({ message: 'Book not found' })
    if (!bookAccess(context, book)) return reply.code(403).send({ message: 'Forbidden' })

    const path = await bookFilePath(book)
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
  }

  app.get<{ Params: { bookId: string; '*'?: string } }>(
    '/api/v1/books/:bookId/file',
    { preHandler: requireRole('FILE_DOWNLOAD') },
    downloadBookFile,
  )
  app.get<{ Params: { bookId: string; '*'?: string } }>(
    '/api/v1/books/:bookId/file/*',
    { preHandler: requireRole('FILE_DOWNLOAD') },
    downloadBookFile,
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
