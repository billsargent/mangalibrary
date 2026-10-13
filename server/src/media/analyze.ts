import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { aggregateSeriesMetadata } from '../metadata/aggregation.js'
import { refreshSeriesMetadata } from '../metadata/series.js'
import { refreshBookMetadata } from '../metadata/refresh.js'
import { onThread } from '../threads/index.js'
import type { AnalysisStatus } from './inspect.js'

export { ANALYSIS_ERRORS, inspectBook } from './inspect.js'
export type { AnalysisStatus, BookInspection, InspectedPage } from './inspect.js'

export interface Analysis {
  status: AnalysisStatus
  mediaType: string | null
  pageCount: number
  comment: string | null
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
  const inspection = await onThread('inspect', { path, options })

  if (inspection.status === 'READY') {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('media')
        .values({
          book_id: bookId,
          media_type: inspection.mediaType,
          status: 'READY',
          comment: inspection.comment,
          page_count: inspection.pages.length,
          created_date: now,
          last_modified_date: now,
        })
        .onConflict((oc) =>
          oc.column('book_id').doUpdateSet({
            media_type: inspection.mediaType,
            status: 'READY',
            comment: inspection.comment,
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
    const owner = await db
      .selectFrom('books')
      .innerJoin('series', 'series.id', 'books.series_id')
      .select(['books.series_id', 'series.oneshot'])
      .where('books.id', '=', bookId)
      .executeTakeFirst()
    // A oneshot is the exception: its series is its one book, title and summary, so
    // the series is read again now that the book has said what it is called. That
    // is one book, not a series' worth.
    if (owner?.oneshot === 1) await refreshSeriesMetadata(db, owner.series_id)
    else if (owner) await aggregateSeriesMetadata(db, owner.series_id)

    return {
      status: 'READY',
      mediaType: inspection.mediaType,
      pageCount: inspection.pages.length,
      comment: inspection.comment,
    }
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
