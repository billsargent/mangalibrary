import type { FastifyInstance } from 'fastify'

import { requireAdmin } from '../auth/session.js'
import { inspectBook } from '../media/analyze.js'
import { openBook } from '../media/index.js'
import { SCAN_ERRORS, ScanError, insideRoot, scanFolder } from '../media/scan.js'
import { TransientBookStore, type TransientBook } from '../media/transient.js'
import { nextTsid } from '../tsid.js'
import { cacheHeaders, isNotModified } from './cache-headers.js'
import { humanSize } from './content-dto.js'
import type { RouteOptions } from './libraries.js'

interface PageDto {
  number: number
  fileName: string
  mediaType: string
  width: number | null
  height: number | null
  sizeBytes: number | null
  size: string
}

/**
 * The transient-book DTO, field for field from the vendored OpenAPI document.
 *
 * `number` and `seriesId` are what a metadata provider would fill in; until that
 * pipeline exists they stay null, which is what the reference sends for a scan
 * that has not been matched to a series.
 */
function toDto(book: TransientBook): Record<string, unknown> {
  const pages: PageDto[] = book.pages.map((page, index) => ({
    number: index + 1,
    fileName: page.fileName,
    mediaType: page.mediaType,
    width: page.width,
    height: page.height,
    sizeBytes: page.size,
    size: page.size === null ? '' : humanSize(page.size),
  }))

  return {
    id: book.id,
    name: book.name,
    url: book.path,
    fileLastModified: book.fileLastModified.toISOString(),
    sizeBytes: book.fileSize,
    size: humanSize(book.fileSize),
    status: book.status,
    mediaType: book.mediaType ?? '',
    pages,
    files: book.files,
    comment: book.comment ?? '',
    number: null,
    seriesId: null,
  }
}

/**
 * Importing a book that is not in a library yet.
 *
 * An admin points the server at a folder, gets back the book files it finds, and
 * then asks for each one to be analysed before importing it. Nothing is written
 * to the database - the reference keeps these in a memory cache, and so does
 * this - so a restart simply forgets an import that was never carried out.
 *
 * The trio is admin-only, as it is in the reference: it reads the server's
 * filesystem and decodes files that no library has vetted.
 */
export async function registerTransientBookRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts
  const store = new TransientBookStore()

  /** Scan a folder for book files and remember them. */
  app.post('/api/v1/transient-books', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown }
    const path = typeof body.path === 'string' ? body.path : ''
    if (path === '') return reply.code(400).send({ message: 'Path is required' })

    // A folder inside a library is that library's to scan, not a transient one.
    const libraries = await db.selectFrom('libraries').select('root').execute()
    if (libraries.some((library) => insideRoot(library.root, path))) {
      return reply.code(400).send({ message: SCAN_ERRORS.insideLibrary })
    }

    let scanned
    try {
      scanned = await scanFolder(path)
    } catch (error) {
      if (error instanceof ScanError) return reply.code(400).send({ message: error.code })
      throw error
    }

    scanned.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

    const now = new Date()
    const books: TransientBook[] = scanned.map((book) => ({
      id: nextTsid(),
      name: book.name,
      path: book.path,
      fileSize: book.fileSize,
      fileLastModified: book.fileLastModified,
      lastModified: now,
      status: 'UNKNOWN',
      mediaType: null,
      pages: [],
      files: [],
      comment: null,
    }))
    for (const book of books) store.save(book)

    return books.map(toDto)
  })

  /** Analyse one scanned book, so its pages can be shown and imported. */
  app.post<{ Params: { id: string } }>(
    '/api/v1/transient-books/:id/analyze',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const book = store.get(req.params.id)
      if (!book) return reply.code(404).send({ message: 'Transient book not found' })

      const inspection = await inspectBook(book.path, { analyzeDimensions: true })
      const updated: TransientBook = {
        ...book,
        lastModified: new Date(),
        status: inspection.status,
        mediaType: inspection.mediaType,
        pages: inspection.pages,
        files: inspection.files.map((file) => file.fileName),
        comment: inspection.comment,
      }
      store.save(updated)

      return toDto(updated)
    },
  )

  /** A page image of an analysed book, for the preview an import shows. */
  app.get<{ Params: { id: string; pageNumber: string } }>(
    '/api/v1/transient-books/:id/pages/:pageNumber',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const book = store.get(req.params.id)
      if (!book) return reply.code(404).send({ message: 'Transient book not found' })
      if (book.status !== 'READY') return reply.code(404).send({ message: 'Book analysis failed' })

      const pageNumber = Number.parseInt(req.params.pageNumber, 10)
      const page = Number.isInteger(pageNumber) ? book.pages[pageNumber - 1] : undefined
      if (!page) return reply.code(400).send({ message: 'Page number does not exist' })

      const headers = cacheHeaders(book.lastModified)
      // The response only changes when the book is analysed again, so a client
      // that already has it is told to keep what it has.
      if (isNotModified(req, book.lastModified)) {
        return reply.headers(headers).code(304).send()
      }

      let contents
      try {
        contents = await openBook(book.path)
      } catch {
        return reply.code(404).send({ message: 'File not found, it may have moved' })
      }

      try {
        const bytes = await contents.readPage(pageNumber)
        return reply
          .headers(headers)
          .type(page.mediaType || 'application/octet-stream')
          .send(bytes)
      } catch {
        return reply.code(400).send({ message: 'Page number does not exist' })
      } finally {
        contents.close()
      }
    },
  )
}
