/**
 * The job handlers: what each queued type actually does.
 *
 * A handler is the whole of a job's behaviour, and it is written to be safe to run
 * twice: the queue deduplicates by unique key, but a job that was interrupted is
 * picked up again after a restart, so everything here checks what it finds rather
 * than assuming it is the first to arrive.
 *
 * A handler that cannot do its work because the thing it needs is gone - a book
 * whose file has been removed, a library that was deleted while its scan waited -
 * says so and returns: the job is done with either way.
 */

import { unlink } from 'node:fs/promises'
import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord } from './content/files.js'
import type { DB } from './db/schema.js'
import { JOB_PRIORITY, enqueueJob, type JobRecord } from './jobs.js'
import { analyzeBook } from './media/analyze.js'
import { refreshBookLocalArtwork, refreshSeriesLocalArtwork } from './metadata/localArtwork.js'
import { refreshBookMetadata } from './metadata/refresh.js'
import { refreshSeriesMetadata } from './metadata/series.js'
import { cleanupEmptySets } from './organisation/cleanup.js'
import { scanLibrary } from './scan/reconcile.js'
import { booksNeedingThumbnail, generateBookThumbnail } from './thumbnails/generate.js'

/**
 * What a handler needs from a logger.
 *
 * Narrower than pino's and than Fastify's, so the worker can be given either -
 * and a test can be given a stub that records what was said.
 */
export interface JobLogger {
  debug(context: Record<string, unknown>, message: string): void
  info(context: Record<string, unknown>, message: string): void
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

export interface JobContext {
  db: Kysely<DB>
  log: JobLogger
}

/** The payloads the routes queue, as they were written. */
interface LibraryPayload {
  libraryId?: unknown
  scanDeep?: unknown
}
interface SeriesPayload {
  seriesId?: unknown
}
interface BookPayload {
  bookId?: unknown
}
interface ThumbnailPayload {
  bookId?: unknown
  forBiggerResultOnly?: unknown
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Queue analysis for the books of a library that need it.
 *
 * A book needs analysing when nothing has described it yet, or when what described
 * it no longer matches the file - which is what a scan marks a changed book as.
 */
async function analyzeMissingBooks(context: JobContext, libraryId: string): Promise<number> {
  const books = await context.db
    .selectFrom('books')
    .leftJoin('media', 'media.book_id', 'books.id')
    .select(['books.id', 'books.series_id'])
    .where('books.library_id', '=', libraryId)
    .where('books.deleted_date', 'is', null)
    .where((eb) => eb.or([eb('media.book_id', 'is', null), eb('media.status', 'in', ['UNKNOWN', 'OUTDATED'])]))
    .orderBy('books.series_id')
    .orderBy('books.number')
    .execute()

  for (const book of books) {
    await enqueueJob(context.db, {
      type: 'AnalyzeBook',
      uniqueKey: `ANALYZE_BOOK_${book.id}`,
      priority: JOB_PRIORITY.HIGH,
      // A series' books are analysed one at a time, in order, so a reader never
      // sees half a series renumbered.
      groupId: book.series_id,
      payload: { bookId: book.id },
    })
  }
  return books.length
}

/** Analyse one book, if its file is still there. Says whether it analysed. */
async function analyzeOne(context: JobContext, bookId: string): Promise<boolean> {
  const record = await findBookRecord(context.db, bookId)
  if (record === null) {
    context.log.warn({ bookId }, 'book to analyse is gone')
    return false
  }

  const path = await bookFilePath(record)
  if (path === null) {
    context.log.warn({ bookId }, 'book to analyse has no file')
    return false
  }

  const library = await context.db
    .selectFrom('libraries')
    .select('analyze_dimensions')
    .where('id', '=', record.libraryId)
    .executeTakeFirst()

  const analysis = await analyzeBook(context.db, bookId, path, {
    analyzeDimensions: library?.analyze_dimensions === 1,
  })
  if (analysis.status !== 'READY') {
    context.log.warn({ bookId, status: analysis.status, comment: analysis.comment }, 'analysis did not succeed')
    return false
  }

  // A cover beside the book is looked for now that the file has been read, and the
  // file is where the scan put it - so a book that was just discovered gets its
  // artwork. The reference does this from its import and sidecar paths.
  const artwork = await refreshBookLocalArtwork(context.db, bookId)
  if (artwork > 0) context.log.info({ bookId, artwork }, 'found artwork beside a book')
  return true
}

/** Queue making a book's poster from its first page. */
async function queueThumbnail(context: JobContext, bookId: string, priority: number): Promise<void> {
  await enqueueJob(context.db, {
    type: 'GenerateBookThumbnail',
    uniqueKey: `GENERATE_BOOK_THUMBNAIL_${bookId}`,
    priority,
    payload: { bookId },
  })
}

/** Make one book's poster, saying so when the book has nothing to make it from. */
async function generateOneThumbnail(context: JobContext, bookId: string): Promise<void> {
  const generated = await generateBookThumbnail(context.db, bookId)
  if (generated === null) {
    context.log.warn({ bookId }, 'no page to make a poster from')
  }
}

/** Queue a poster for every book that wants one, which is all of them on request. */
async function regenerateThumbnails(context: JobContext, payload: ThumbnailPayload, priority: number): Promise<void> {
  const forBiggerResultOnly = payload.forBiggerResultOnly === true
  const bookIds = await booksNeedingThumbnail(context.db, { forBiggerResultOnly })

  for (const bookId of bookIds) await queueThumbnail(context, bookId, priority)
  context.log.info({ queued: bookIds.length, forBiggerResultOnly }, 'queued books to regenerate posters for')
}

/** Delete what a scan soft-deleted, which is the only thing that removes rows. */
async function emptyTrash(context: JobContext, libraryId: string): Promise<number> {
  const books = await context.db
    .deleteFrom('books')
    .where('library_id', '=', libraryId)
    .where('deleted_date', 'is not', null)
    .executeTakeFirst()
  const series = await context.db
    .deleteFrom('series')
    .where('library_id', '=', libraryId)
    .where('deleted_date', 'is not', null)
    .executeTakeFirst()

  // A set that has just lost everything it held is removed with it, if the server is
  // set to, which is where the reference does the same thing.
  const cleaned = await cleanupEmptySets(context.db)
  if (cleaned.collectionsDeleted > 0 || cleaned.readListsDeleted > 0) {
    context.log.info({ ...cleaned }, 'removed collections and read lists that hold nothing')
  }

  return Number(books.numDeletedRows ?? 0) + Number(series.numDeletedRows ?? 0)
}

/** Remove a book's file, then record the book as deleted the way a scan would. */
async function deleteBookFile(context: JobContext, bookId: string): Promise<void> {
  const record = await findBookRecord(context.db, bookId)
  if (record === null) return

  const path = await bookFilePath(record)
  if (path !== null) {
    await unlink(path).catch((error: unknown) => {
      context.log.warn({ bookId, err: String(error) }, 'could not remove a book file')
    })
  }

  // The artwork found beside the book goes with it, as it does in the reference: it
  // belongs to that book and nothing else names it.
  const covers = await context.db
    .selectFrom('thumbnails')
    .select('url')
    .where('owner_type', '=', 'BOOK')
    .where('owner_id', '=', bookId)
    .where('type', '=', 'SIDECAR')
    .where('url', 'is not', null)
    .execute()
  for (const cover of covers) {
    if (cover.url === null) continue
    await unlink(cover.url).catch((error: unknown) => {
      context.log.warn({ bookId, err: String(error) }, 'could not remove a book\u2019s artwork file')
    })
  }

  const now = new Date().toISOString()
  await context.db
    .updateTable('books')
    .set({ deleted_date: now, last_modified_date: now })
    .where('id', '=', bookId)
    .execute()
}

/** Remove every file of a series, and the series with them. */
async function deleteSeriesFiles(context: JobContext, seriesId: string): Promise<void> {
  const books = await context.db
    .selectFrom('books')
    .select('id')
    .where('series_id', '=', seriesId)
    .where('deleted_date', 'is', null)
    .execute()

  for (const book of books) await deleteBookFile(context, book.id)

  const now = new Date().toISOString()
  await context.db
    .updateTable('series')
    .set({ deleted_date: now, last_modified_date: now })
    .where('id', '=', seriesId)
    .execute()
}

/** Run one job. Throwing is allowed: the worker logs it and drops the job. */
export async function handleJob(context: JobContext, job: JobRecord): Promise<void> {
  const { db, log } = context

  switch (job.type) {
    case 'ScanLibrary': {
      const payload = job.payload as LibraryPayload
      const libraryId = text(payload.libraryId)
      if (libraryId === null) return log.warn({ job: job.id }, 'ScanLibrary without a library')

      const summary = await scanLibrary(db, libraryId, { deep: payload.scanDeep === true })
      log.info({ libraryId, ...summary }, 'scanned a library')
      const queued = await analyzeMissingBooks(context, libraryId)
      if (queued > 0) log.info({ libraryId, queued }, 'queued books to analyse')
      return
    }

    case 'AnalyzeLibrary': {
      const libraryId = text((job.payload as LibraryPayload).libraryId)
      if (libraryId === null) return log.warn({ job: job.id }, 'AnalyzeLibrary without a library')

      const queued = await analyzeMissingBooks(context, libraryId)
      log.info({ libraryId, queued }, 'queued a library to analyse')
      return
    }

    case 'AnalyzeSeries': {
      const seriesId = text((job.payload as SeriesPayload).seriesId)
      if (seriesId === null) return log.warn({ job: job.id }, 'AnalyzeSeries without a series')

      const books = await db
        .selectFrom('books')
        .select('id')
        .where('series_id', '=', seriesId)
        .where('deleted_date', 'is', null)
        .orderBy('number')
        .execute()

      for (const book of books) {
        await enqueueJob(db, {
          type: 'AnalyzeBook',
          uniqueKey: `ANALYZE_BOOK_${book.id}`,
          priority: JOB_PRIORITY.HIGH,
          groupId: seriesId,
          payload: { bookId: book.id },
        })
      }
      return
    }

    case 'AnalyzeBook': {
      const bookId = text((job.payload as BookPayload).bookId)
      if (bookId === null) return log.warn({ job: job.id }, 'AnalyzeBook without a book')

      const analysed = await analyzeOne(context, bookId)
      // A book that analysed has a first page to make a poster from, and making it
      // is a job of its own - which is also how the reference arranges it.
      if (analysed) await queueThumbnail(context, bookId, job.priority + 1)
      return
    }

    case 'RefreshBookMetadata': {
      const bookId = text((job.payload as BookPayload).bookId)
      if (bookId === null) return log.warn({ job: job.id }, 'RefreshBookMetadata without a book')

      const result = await refreshBookMetadata(db, bookId)
      log.info({ bookId, status: result.status, changed: result.changed }, 'refreshed a book')

      // What a book says about its series is part of the series' metadata, and the
      // reference refreshes that from a task of its own - which the unique key
      // collapses when several books of one series ask for it at once.
      const book = await db.selectFrom('books').select('series_id').where('id', '=', bookId).executeTakeFirst()
      if (book) {
        await enqueueJob(db, {
          type: 'RefreshSeriesMetadata',
          uniqueKey: `REFRESH_SERIES_METADATA_${book.series_id}`,
          priority: job.priority - 1,
          payload: { seriesId: book.series_id },
        })
      }
      return
    }

    case 'RefreshSeriesMetadata': {
      const seriesId = text((job.payload as SeriesPayload).seriesId)
      if (seriesId === null) return log.warn({ job: job.id }, 'RefreshSeriesMetadata without a series')

      const result = await refreshSeriesMetadata(db, seriesId)
      return log.info(
        { seriesId, status: result.status, changed: result.changed, collections: result.collections },
        'refreshed a series',
      )
    }

    case 'RefreshLibraryMetadata': {
      const libraryId = text((job.payload as LibraryPayload).libraryId)
      if (libraryId === null) return log.warn({ job: job.id }, 'RefreshLibraryMetadata without a library')

      const books = await db
        .selectFrom('books')
        .select('id')
        .where('library_id', '=', libraryId)
        .where('deleted_date', 'is', null)
        .orderBy('series_id')
        .orderBy('number')
        .execute()

      for (const book of books) {
        await enqueueJob(db, {
          type: 'RefreshBookMetadata',
          uniqueKey: `REFRESH_BOOK_METADATA_${book.id}`,
          payload: { bookId: book.id },
        })
        await enqueueJob(db, {
          type: 'RefreshBookLocalArtwork',
          uniqueKey: `REFRESH_BOOK_LOCAL_ARTWORK_${book.id}`,
          payload: { bookId: book.id },
        })
      }

      // A series' own cover sits in the series' folder, so the series are asked for
      // theirs too - which is what a library-wide refresh means in the reference.
      const series = await db
        .selectFrom('series')
        .select('id')
        .where('library_id', '=', libraryId)
        .where('deleted_date', 'is', null)
        .execute()

      for (const entry of series) {
        await enqueueJob(db, {
          type: 'RefreshSeriesLocalArtwork',
          uniqueKey: `REFRESH_SERIES_LOCAL_ARTWORK_${entry.id}`,
          payload: { seriesId: entry.id },
        })
      }
      return
    }

    case 'EmptyTrash': {
      const libraryId = text((job.payload as LibraryPayload).libraryId)
      if (libraryId === null) return log.warn({ job: job.id }, 'EmptyTrash without a library')

      const removed = await emptyTrash(context, libraryId)
      return log.info({ libraryId, removed }, 'emptied the trash')
    }

    case 'DeleteBookFile': {
      const bookId = text((job.payload as BookPayload).bookId)
      if (bookId === null) return log.warn({ job: job.id }, 'DeleteBookFile without a book')
      return deleteBookFile(context, bookId)
    }

    case 'DeleteSeriesFile': {
      const seriesId = text((job.payload as SeriesPayload).seriesId)
      if (seriesId === null) return log.warn({ job: job.id }, 'DeleteSeriesFile without a series')
      return deleteSeriesFiles(context, seriesId)
    }

    case 'RefreshBookLocalArtwork': {
      const bookId = text((job.payload as BookPayload).bookId)
      if (bookId === null) return log.warn({ job: job.id }, 'RefreshBookLocalArtwork without a book')

      const stored = await refreshBookLocalArtwork(db, bookId)
      return log.info({ bookId, stored }, 'looked for artwork beside a book')
    }

    case 'RefreshSeriesLocalArtwork': {
      const seriesId = text((job.payload as SeriesPayload).seriesId)
      if (seriesId === null) return log.warn({ job: job.id }, 'RefreshSeriesLocalArtwork without a series')

      const stored = await refreshSeriesLocalArtwork(db, seriesId)
      return log.info({ seriesId, stored }, 'looked for a cover in a series folder')
    }

    case 'GenerateBookThumbnail': {
      const bookId = text((job.payload as ThumbnailPayload).bookId)
      if (bookId === null) return log.warn({ job: job.id }, 'GenerateBookThumbnail without a book')
      return generateOneThumbnail(context, bookId)
    }

    case 'RegenerateBookThumbnails':
      return regenerateThumbnails(context, job.payload as ThumbnailPayload, job.priority)

    case 'GenerateSeriesThumbnail':
    case 'GenerateCollectionThumbnail':
    case 'GenerateReadListThumbnail': {
      // A series shows one of its books' posters, and a collection or read list
      // shows a mosaic of four members: both are built when they are asked for, so
      // there is nothing to generate ahead of time. The types are accepted so that
      // anything already queued still drains.
      return log.debug({ type: job.type }, 'nothing to generate for this owner')
    }

    default:
      return log.warn({ type: job.type, job: job.id }, 'unknown job type')
  }
}
