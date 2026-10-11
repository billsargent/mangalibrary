import sharp from 'sharp'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { aggregateSeriesMetadata } from '../metadata/aggregation.js'
import { refreshBookMetadata } from '../metadata/refresh.js'
import { computePositions } from './epub.js'
import { openBook } from './index.js'
import { isImageEntry } from './kinds.js'
import type { Position, TocEntry } from './types.js'

export type AnalysisStatus = 'READY' | 'ERROR' | 'UNSUPPORTED'

export interface Analysis {
  status: AnalysisStatus
  mediaType: string | null
  pageCount: number
  comment: string | null
}

/**
 * The codes the reference puts in `media.comment` when analysis fails, kept so a
 * client that reads them keeps working.
 */
export const ANALYSIS_ERRORS = {
  unreadable: 'ERR_1000',
  unsupported: 'ERR_1001',
  unknown: 'ERR_1005',
} as const

async function imageSize(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const metadata = await sharp(buffer).metadata()
    return { width: metadata.width ?? null, height: metadata.height ?? null }
  } catch {
    return { width: null, height: null }
  }
}

/** One page of a book, as opening the book described it. */
export interface InspectedPage {
  fileName: string
  mediaType: string
  width: number | null
  height: number | null
  /** Bytes, when the container knows before reading; PDF pages are rendered. */
  size: number | null
}

/**
 * What opening a book tells us, before any of it is written down.
 *
 * Analysis is split in two so that the same reading serves both the scanner,
 * which persists it in the media tables, and the transient-book endpoints, which
 * have no book row to persist it against.
 */
export interface BookInspection {
  status: AnalysisStatus
  mediaType: string | null
  pages: InspectedPage[]
  files: { fileName: string; size: number }[]
  /** The table of contents of an EPUB, or null for the other containers. */
  epubToc: TocEntry[] | null
  /** The Readium positions of an EPUB, or null for the other containers. */
  positions: Position[] | null
  comment: string | null
}

/**
 * Open a book and describe what is inside it, without writing anything.
 *
 * This never throws for a bad file: a book that cannot be read comes back as an
 * error inspection, the same way the scanner records it, so a caller can show it
 * and an operator can see why.
 */
export async function inspectBook(
  path: string,
  options: { analyzeDimensions?: boolean } = {},
): Promise<BookInspection> {
  try {
    const book = await openBook(path)
    try {
      const pages: InspectedPage[] = []

      for (const [index, page] of book.pages.entries()) {
        // Dimensions are only known by decoding an image, which is the expensive
        // part of analysis, so a caller can turn it off.
        const size =
          options.analyzeDimensions === true && isImageEntry(page.fileName)
            ? await imageSize(await book.readPage(index + 1))
            : { width: null, height: null }

        pages.push({
          fileName: page.fileName,
          mediaType: page.mediaType,
          width: size.width,
          height: size.height,
          size: page.size,
        })
      }

      return {
        status: 'READY',
        mediaType: book.mediaType,
        pages,
        files: book.files.map((file) => ({ fileName: file.fileName, size: file.size })),
        epubToc: book.epub?.toc ?? null,
        positions: book.epub ? computePositions(book.pages) : null,
        comment: null,
      }
    } finally {
      book.close()
    }
  } catch (error) {
    const message = (error as Error).message
    const unsupported = message.includes('is not a book container')
    const status: AnalysisStatus = unsupported ? 'UNSUPPORTED' : 'ERROR'
    const code = unsupported ? ANALYSIS_ERRORS.unsupported : ANALYSIS_ERRORS.unknown
    return {
      status,
      mediaType: null,
      pages: [],
      files: [],
      epubToc: null,
      positions: null,
      comment: `${code} ${message}`,
    }
  }
}

/**
 * Open a book, learn what is inside it, and write what it learns.
 *
 * This is the step the scanner runs for a new or changed file, and the reason the
 * media tables exist at all: the page list a reader shows, the page count a series
 * aggregates, and the flag that decides whether an EPUB opens in the Divina
 * reader. Analysis never throws for a bad file - a book that cannot be read is
 * recorded as an error, so the library can show it and an operator can see why.
 */
export async function analyzeBook(
  db: Kysely<DB>,
  bookId: string,
  path: string,
  options: { analyzeDimensions?: boolean } = {},
): Promise<Analysis> {
  const now = new Date().toISOString()
  const inspection = await inspectBook(path, options)

  if (inspection.status === 'READY') {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('media')
        .values({
          book_id: bookId,
          media_type: inspection.mediaType,
          status: 'READY',
          comment: null,
          page_count: inspection.pages.length,
          created_date: now,
          last_modified_date: now,
        })
        .onConflict((oc) =>
          oc.column('book_id').doUpdateSet({
            media_type: inspection.mediaType,
            status: 'READY',
            comment: null,
            page_count: inspection.pages.length,
            last_modified_date: now,
          }),
        )
        .execute()

      await trx.deleteFrom('media_page').where('book_id', '=', bookId).execute()
      if (inspection.pages.length > 0) {
        await trx
          .insertInto('media_page')
          .values(
            inspection.pages.map((page, index) => ({
              book_id: bookId,
              number: index + 1,
              file_name: page.fileName,
              media_type: page.mediaType,
              width: page.width,
              height: page.height,
              file_size: page.size,
            })),
          )
          .execute()
      }

      await trx.deleteFrom('media_file').where('book_id', '=', bookId).execute()
      if (inspection.files.length > 0) {
        await trx
          .insertInto('media_file')
          .values(inspection.files.map((file) => ({ book_id: bookId, file_name: file.fileName })))
          .execute()
      }

      await trx.deleteFrom('media_container').where('book_id', '=', bookId).execute()
      await trx
        .insertInto('media_container')
        .values({ book_id: bookId, entries: JSON.stringify(inspection.files) })
        .execute()

      // Only an EPUB has a table of contents; the other containers leave the
      // table empty rather than keeping whatever a previous analysis wrote.
      await trx.deleteFrom('epub_toc').where('book_id', '=', bookId).execute()
      if (inspection.epubToc) {
        await trx
          .insertInto('epub_toc')
          .values({ book_id: bookId, toc: JSON.stringify(inspection.epubToc) })
          .execute()
      }

      await trx.deleteFrom('epub_positions').where('book_id', '=', bookId).execute()
      if (inspection.positions) {
        await trx
          .insertInto('epub_positions')
          .values({ book_id: bookId, positions: JSON.stringify(inspection.positions) })
          .execute()
      }
    })

    // Reading metadata out of the file is its own task in the reference, which
    // schedules the refresh once analysis reports what it learned; until the job
    // worker exists it happens here, so that analysing a book is all a caller has
    // to do. A document that cannot be read is reported, never thrown, so it
    // cannot fail an analysis that otherwise worked.
    await refreshBookMetadata(db, bookId, { path })

    // A book's metadata is what a series' booksMetadata is made of, so the series'
    // view of its books is recomputed here. The reference does this through a task
    // of its own, and also re-reads the series' documents; reading every book of
    // the series again for each of its books analysed would be quadratic, so that
    // part is left to a scan, which does it once per series.
    const owner = await db.selectFrom('books').select('series_id').where('id', '=', bookId).executeTakeFirst()
    if (owner) await aggregateSeriesMetadata(db, owner.series_id)

    return { status: 'READY', mediaType: inspection.mediaType, pageCount: inspection.pages.length, comment: null }
  }

  await db
    .insertInto('media')
    .values({
      book_id: bookId,
      media_type: null,
      status: inspection.status,
      comment: inspection.comment,
      page_count: 0,
      created_date: now,
      last_modified_date: now,
    })
    .onConflict((oc) =>
      oc.column('book_id').doUpdateSet({
        media_type: null,
        status: inspection.status,
        comment: inspection.comment,
        page_count: 0,
        last_modified_date: now,
      }),
    )
    .execute()

  await db.deleteFrom('media_page').where('book_id', '=', bookId).execute()
  await db.deleteFrom('epub_positions').where('book_id', '=', bookId).execute()
  return { status: inspection.status, mediaType: null, pageCount: 0, comment: inspection.comment }
}
