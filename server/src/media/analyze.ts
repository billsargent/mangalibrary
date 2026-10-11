import sharp from 'sharp'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { openBook } from './index.js'
import { isImageEntry } from './kinds.js'

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
  let analysis: Analysis

  try {
    const book = await openBook(path)
    try {
      const pages: {
        book_id: string
        number: number
        file_name: string
        media_type: string
        width: number | null
        height: number | null
        file_size: number | null
      }[] = []

      for (const [index, page] of book.pages.entries()) {
        // Dimensions are only known by decoding an image, which is the expensive
        // part of analysis, so a library can turn it off.
        const size =
          options.analyzeDimensions === true && isImageEntry(page.fileName)
            ? await imageSize(await book.readPage(index + 1))
            : { width: null, height: null }

        pages.push({
          book_id: bookId,
          number: index + 1,
          file_name: page.fileName,
          media_type: page.mediaType,
          width: size.width,
          height: size.height,
          file_size: page.size,
        })
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('media')
          .values({
            book_id: bookId,
            media_type: book.mediaType,
            status: 'READY',
            comment: null,
            page_count: pages.length,
            created_date: now,
            last_modified_date: now,
          })
          .onConflict((oc) =>
            oc.column('book_id').doUpdateSet({
              media_type: book.mediaType,
              status: 'READY',
              comment: null,
              page_count: pages.length,
              last_modified_date: now,
            }),
          )
          .execute()

        await trx.deleteFrom('media_page').where('book_id', '=', bookId).execute()
        if (pages.length > 0) {
          await trx.insertInto('media_page').values(pages).execute()
        }

        await trx.deleteFrom('media_file').where('book_id', '=', bookId).execute()
        if (book.files.length > 0) {
          await trx
            .insertInto('media_file')
            .values(book.files.map((file) => ({ book_id: bookId, file_name: file.fileName })))
            .execute()
        }

        await trx.deleteFrom('media_container').where('book_id', '=', bookId).execute()
        await trx
          .insertInto('media_container')
          .values({
            book_id: bookId,
            entries: JSON.stringify(book.files.map((file) => ({ fileName: file.fileName, size: file.size }))),
          })
          .execute()

        // Only an EPUB has a table of contents; the other containers leave the
        // table empty rather than keeping whatever a previous analysis wrote.
        await trx.deleteFrom('epub_toc').where('book_id', '=', bookId).execute()
        if (book.epub) {
          await trx
            .insertInto('epub_toc')
            .values({ book_id: bookId, toc: JSON.stringify(book.epub.toc) })
            .execute()
        }
      })

      analysis = { status: 'READY', mediaType: book.mediaType, pageCount: pages.length, comment: null }
    } finally {
      book.close()
    }
  } catch (error) {
    const message = (error as Error).message
    const unsupported = message.includes('is not a book container')
    const status: AnalysisStatus = unsupported ? 'UNSUPPORTED' : 'ERROR'
    const code = unsupported ? ANALYSIS_ERRORS.unsupported : ANALYSIS_ERRORS.unknown
    const comment = `${code} ${message}`

    await db
      .insertInto('media')
      .values({
        book_id: bookId,
        media_type: null,
        status,
        comment,
        page_count: 0,
        created_date: now,
        last_modified_date: now,
      })
      .onConflict((oc) =>
        oc.column('book_id').doUpdateSet({
          media_type: null,
          status,
          comment,
          page_count: 0,
          last_modified_date: now,
        }),
      )
      .execute()

    await db.deleteFrom('media_page').where('book_id', '=', bookId).execute()
    analysis = { status, mediaType: null, pageCount: 0, comment }
  }

  return analysis
}
