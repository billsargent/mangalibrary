import { pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { announceBook, announceSeries, bookRef } from '../content-events.js'
import type { EventBus } from '../events.js'
import { naturalCompare } from '../media/kinds.js'
import { refreshSeriesLocalArtwork } from '../metadata/localArtwork.js'
import { refreshSeriesMetadata } from '../metadata/series.js'
import { cleanupEmptySets } from '../organisation/cleanup.js'
import { nextTsid } from '../tsid.js'
import { LibraryScanError, walkLibrary, type ScannedBook, type ScanSettings } from './library.js'
import { deletedBookFor, deletedBookSizes, restoreBook, type DeletedBook } from './restore.js'

/** What a scan did, so a caller can report it. */
export interface ScanSummary {
  seriesCreated: number
  seriesUpdated: number
  seriesDeleted: number
  booksCreated: number
  booksUpdated: number
  booksDeleted: number
  /** Series and books that were in the trash and came back with their files. */
  seriesRestored: number
  booksRestored: number
  /** Collections and read lists removed because the scan emptied them. */
  collectionsDeleted: number
  readListsDeleted: number
}

/**
 * The name a book is sorted by.
 *
 * The reference trims, strips accents and collapses whitespace before comparing,
 * so that `Tome 1` and `Tôme 1` sit together and a stray double space does not
 * move a book.
 */
function sortName(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

/** The library's exclusion list, from either place it is stored. */
async function exclusionsOf(db: Kysely<DB>, libraryId: string, stored: string): Promise<string[]> {
  const rows = await db
    .selectFrom('library_exclusions')
    .select('exclusion')
    .where('library_id', '=', libraryId)
    .execute()
  const fromTable = rows.map((row) => row.exclusion)

  let fromColumn: string[] = []
  try {
    const parsed = JSON.parse(stored)
    if (Array.isArray(parsed)) fromColumn = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    // A column that is not a list is treated as no exclusions rather than failing.
  }

  return [...new Set([...fromTable, ...fromColumn])]
}

async function scanSettings(
  db: Kysely<DB>,
  library: {
    id: string
    scan_cbx: number
    scan_pdf: number
    scan_epub: number
    scan_force_modified_time: number
    oneshots_directory: string | null
    scan_directory_exclusions: string
  },
): Promise<ScanSettings> {
  return {
    scanCbx: library.scan_cbx === 1,
    scanPdf: library.scan_pdf === 1,
    scanEpub: library.scan_epub === 1,
    oneshotsDirectory: library.oneshots_directory,
    exclusions: await exclusionsOf(db, library.id, library.scan_directory_exclusions),
    forceDirectoryModifiedTime: library.scan_force_modified_time === 1,
  }
}

/** Add books to a series, with the metadata row each one needs. Returns their ids. */
async function addBooks(
  db: Kysely<DB>,
  seriesId: string,
  libraryId: string,
  books: readonly ScannedBook[],
  now: string,
): Promise<string[]> {
  const created: string[] = []
  for (const book of books) {
    const id = nextTsid()
    created.push(id)
    await db
      .insertInto('books')
      .values({
        id,
        series_id: seriesId,
        library_id: libraryId,
        name: book.name,
        url: pathToFileURL(book.path).href,
        file_last_modified: book.fileLastModified.toISOString(),
        file_size: book.fileSize,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await db
      .insertInto('book_metadata')
      .values({ book_id: id, title: book.name, created_date: now, last_modified_date: now })
      .execute()
  }
  return created
}

/**
 * Number a series' books from 1, in the order a reader expects.
 *
 * The book row's number drives ordering; the metadata's number and sort key are
 * kept in step unless they are locked, which is the user saying they know better.
 */
async function sortBooks(db: Kysely<DB>, seriesId: string, now: string): Promise<void> {
  const books = await db
    .selectFrom('books')
    .select(['id', 'name'])
    .where('series_id', '=', seriesId)
    .where('deleted_date', 'is', null)
    .execute()
  books.sort((left, right) => naturalCompare(sortName(left.name), sortName(right.name)))

  if (books.length > 0) {
    const metadata = await db
      .selectFrom('book_metadata')
      .select(['book_id', 'number', 'number_sort', 'number_lock', 'number_sort_lock'])
      .where(
        'book_id',
        'in',
        books.map((book) => book.id),
      )
      .execute()
    const byBook = new Map(metadata.map((row) => [row.book_id, row]))

    for (const [index, book] of books.entries()) {
      await db
        .updateTable('books')
        .set({ number: index + 1 })
        .where('id', '=', book.id)
        .execute()

      const meta = byBook.get(book.id)
      if (!meta) continue
      const number = meta.number_lock === 1 ? meta.number : String(index + 1)
      const numberSort = meta.number_sort_lock === 1 ? meta.number_sort : index + 1
      if (number !== meta.number || numberSort !== meta.number_sort) {
        await db
          .updateTable('book_metadata')
          .set({ number, number_sort: numberSort, last_modified_date: now })
          .where('book_id', '=', book.id)
          .execute()
      }
    }
  }

  await db.updateTable('series').set({ book_count: books.length }).where('id', '=', seriesId).execute()
}

/** Soft-delete books, which is what the trash bin holds. */
async function softDeleteBooks(db: Kysely<DB>, bookIds: readonly string[], now: string): Promise<void> {
  if (bookIds.length === 0) return
  await db.updateTable('books').set({ deleted_date: now, last_modified_date: now }).where('id', 'in', bookIds).execute()
}

/**
 * The deleted series a folder is, judged by the books its files were matched to.
 *
 * Every file has to be a book of the same deleted series, and the series has to
 * have no other book: a folder holding only some of a series' books, or books of
 * two series, is a new series that those books move into.
 */
async function returningSeries(db: Kysely<DB>, matches: readonly (DeletedBook | null)[]): Promise<string | null> {
  const first = matches[0]
  if (!first || matches.some((match) => match?.seriesId !== first.seriesId)) return null

  const series = await db
    .selectFrom('series')
    .select('deleted_date')
    .where('id', '=', first.seriesId)
    .executeTakeFirst()
  if (!series || series.deleted_date === null) return null

  const books = await db.selectFrom('books').select('id').where('series_id', '=', first.seriesId).execute()
  return books.length === matches.length ? first.seriesId : null
}

/**
 * Scan a library and make the database match what is on disk.
 *
 * The walk is `walkLibrary`; this half decides what to write. A series or book
 * that is gone is soft-deleted rather than removed, so the trash bin holds it and
 * a returning file can be matched back to it by its hash - see `restore.ts` and
 * `docs/SCANNING.md`. A book whose file changed has its media marked outdated,
 * because whatever analysis recorded no longer describes it.
 *
 * A walk that cannot proceed marks the library unavailable and throws; a walk
 * that succeeds clears the mark. When the library asks for it, the trash is
 * emptied at the end, which is the only thing that hard-deletes.
 */
export async function scanLibrary(
  db: Kysely<DB>,
  libraryId: string,
  options: { deep?: boolean; events?: EventBus } = {},
): Promise<ScanSummary> {
  const now = new Date().toISOString()
  const library = await db.selectFrom('libraries').selectAll().where('id', '=', libraryId).executeTakeFirst()
  if (!library) throw new Error(`library ${libraryId} does not exist`)

  // A scan without a bus changes the database silently, which is what a test wants
  // and what a caller that is not the server gets.
  const events = options.events

  const settings = await scanSettings(db, library)

  let found
  try {
    found = await walkLibrary(library.root, settings)
  } catch (error) {
    if (error instanceof LibraryScanError) {
      await db
        .updateTable('libraries')
        .set({ unavailable_date: now, last_modified_date: now })
        .where('id', '=', libraryId)
        .execute()
    }
    throw error
  }

  if (library.unavailable_date !== null) {
    await db
      .updateTable('libraries')
      .set({ unavailable_date: null, last_modified_date: now })
      .where('id', '=', libraryId)
      .execute()
  }

  const summary: ScanSummary = {
    seriesCreated: 0,
    seriesUpdated: 0,
    seriesDeleted: 0,
    booksCreated: 0,
    booksUpdated: 0,
    booksDeleted: 0,
    seriesRestored: 0,
    booksRestored: 0,
    collectionsDeleted: 0,
    readListsDeleted: 0,
  }

  const existing = await db.selectFrom('series').selectAll().where('library_id', '=', libraryId).execute()
  const byUrl = new Map(existing.map((row) => [row.url, row]))
  const scannedUrls = new Set(found.map((series) => pathToFileURL(series.path).href))
  const touched = new Set<string>()

  // Whatever is no longer on disk is soft-deleted first, so the trash bin sees it.
  // A scan that found nothing at all soft-deletes everything: an empty library is
  // what an empty folder means.
  const vanished = existing.filter((row) => row.deleted_date === null && !scannedUrls.has(row.url))
  if (vanished.length > 0) {
    const ids = vanished.map((row) => row.id)
    const books = await db
      .selectFrom('books')
      .select('id')
      .where('series_id', 'in', ids)
      .where('deleted_date', 'is', null)
      .execute()
    await db.transaction().execute(async (trx) => {
      await softDeleteBooks(
        trx,
        books.map((row) => row.id),
        now,
      )
      await trx
        .updateTable('series')
        .set({ deleted_date: now, last_modified_date: now })
        .where('id', 'in', ids)
        .execute()
    })
    summary.seriesDeleted += ids.length
    summary.booksDeleted += books.length

    if (events) {
      for (const row of vanished) announceSeries(events, 'SeriesDeleted', { seriesId: row.id, libraryId })
      for (const book of books) {
        const ref = await bookRef(db, book.id)
        if (ref) announceBook(events, 'BookDeleted', ref)
      }
    }
  }

  // Books that left a series which is still there go to the trash before anything
  // is added, whichever order the series come in: a file moved from one series to
  // another has to be in the trash for the series it arrived in to find it.
  const scannedBookUrls = new Set(found.flatMap((series) => series.books.map((book) => pathToFileURL(book.path).href)))
  const lost = (
    await db
      .selectFrom('books')
      .select(['id', 'series_id', 'url'])
      .where('library_id', '=', libraryId)
      .where('deleted_date', 'is', null)
      .execute()
  ).filter((row) => !scannedBookUrls.has(row.url))
  const seriesWithLoss = new Set(lost.map((row) => row.series_id))
  if (lost.length > 0) {
    await softDeleteBooks(
      db,
      lost.map((row) => row.id),
      now,
    )
    summary.booksDeleted += lost.length
    if (events) {
      for (const row of lost)
        announceBook(events, 'BookDeleted', { bookId: row.id, seriesId: row.series_id, libraryId })
    }
  }

  /**
   * Everything a scan writes for one series, as one piece of work.
   *
   * A scan can be stopped at any moment - a restart, a drive going away. Written
   * row by row, a stop could leave a series with no metadata row, which every
   * listing then hides, or a series recorded as up to date with half its books,
   * which the next scan would see no reason to look at again. Written together,
   * a series is either as the scan left it or as it was, and what it was is what
   * the next scan picks up from.
   *
   * What is announced waits until the work is kept: nobody is told of a book that
   * a rolled-back write then never had.
   */
  type Later = (() => void)[]
  const together = async (work: (trx: Kysely<DB>, later: Later) => Promise<void>): Promise<void> => {
    const later: Later = []
    await db.transaction().execute((trx) => work(trx, later))
    for (const announce of later) announce()
  }

  /** Put a file the library did not have into a series: the book it was, or a new one. */
  const arrive = async (
    trx: Kysely<DB>,
    later: Later,
    seriesId: string,
    book: ScannedBook,
    match: DeletedBook | null,
  ): Promise<void> => {
    if (match === null) {
      const [bookId] = await addBooks(trx, seriesId, libraryId, [book], now)
      summary.booksCreated += 1
      if (events && bookId !== undefined)
        later.push(() => announceBook(events, 'BookAdded', { bookId, seriesId, libraryId }))
      return
    }
    await restoreBook(trx, match.id, { seriesId, libraryId }, book, now)
    summary.booksRestored += 1
    // A list that dropped the book when it was deleted is told it is back.
    if (events) later.push(() => announceBook(events, 'BookAdded', { bookId: match.id, seriesId, libraryId }))
  }

  // What is in the trash that a new file could turn out to be, by size. Everything
  // this scan found gone is in the trash by now.
  const trashSizes = await deletedBookSizes(db)

  for (const scanned of found) {
    const url = pathToFileURL(scanned.path).href
    const current = byUrl.get(url)

    if (!current) {
      const matches: (DeletedBook | null)[] = []
      const taken = new Set<string>()
      for (const book of scanned.books) {
        const match = await deletedBookFor(db, book, taken, trashSizes)
        if (match) taken.add(match.id)
        matches.push(match)
      }

      // A folder whose every file is a book of one deleted series, with none of
      // that series left over, is that series under a new name or in a new place.
      const returning = await returningSeries(db, matches)
      if (returning !== null) {
        await together(async (trx, later) => {
          await trx
            .updateTable('series')
            .set({
              library_id: libraryId,
              name: scanned.name,
              url,
              file_last_modified: scanned.fileLastModified.toISOString(),
              oneshot: scanned.oneshot ? 1 : 0,
              deleted_date: null,
              last_modified_date: now,
            })
            .where('id', '=', returning)
            .execute()
          summary.seriesRestored += 1
          if (events) later.push(() => announceSeries(events, 'SeriesAdded', { seriesId: returning, libraryId }))
          for (const [index, book] of scanned.books.entries()) {
            await arrive(trx, later, returning, book, matches[index] ?? null)
          }
          await sortBooks(trx, returning, now)
        })
        touched.add(returning)
        continue
      }

      const seriesId = nextTsid()
      await together(async (trx, later) => {
        await trx
          .insertInto('series')
          .values({
            id: seriesId,
            library_id: libraryId,
            name: scanned.name,
            url,
            file_last_modified: scanned.fileLastModified.toISOString(),
            oneshot: scanned.oneshot ? 1 : 0,
            created_date: now,
            last_modified_date: now,
          })
          .execute()
        await trx
          .insertInto('series_metadata')
          .values({
            series_id: seriesId,
            title: scanned.name,
            title_sort: scanned.name,
            created_date: now,
            last_modified_date: now,
          })
          .execute()
        summary.seriesCreated += 1
        if (events) later.push(() => announceSeries(events, 'SeriesAdded', { seriesId, libraryId }))
        for (const [index, book] of scanned.books.entries()) {
          await arrive(trx, later, seriesId, book, matches[index] ?? null)
        }
        await sortBooks(trx, seriesId, now)
      })
      touched.add(seriesId)
      continue
    }

    const books = await db
      .selectFrom('books')
      .select(['id', 'name', 'url', 'file_last_modified', 'file_size', 'deleted_date'])
      .where('series_id', '=', current.id)
      .execute()
    const liveByUrl = new Map(books.filter((row) => row.deleted_date === null).map((row) => [row.url, row]))
    const deletedByUrl = new Map(books.filter((row) => row.deleted_date !== null).map((row) => [row.url, row]))

    const changed =
      current.file_last_modified !== scanned.fileLastModified.toISOString() || current.deleted_date !== null

    if (changed || seriesWithLoss.has(current.id) || options.deep === true) {
      // Which deleted book each new file is, found before anything is written:
      // finding out can mean reading the file, and nothing else can use the
      // database while a piece of work is being written.
      const arrivals = new Map<string, DeletedBook | null>()
      const taken = new Set<string>()
      for (const book of scanned.books) {
        const bookUrl = pathToFileURL(book.path).href
        if (liveByUrl.has(bookUrl)) continue
        // A file where a deleted book's file was, of the same size and date, is
        // unchanged by every measure the scan has, so it is that book without
        // being read. Anything else has to prove itself by its hash.
        const was = deletedByUrl.get(bookUrl)
        const same =
          was !== undefined &&
          !taken.has(was.id) &&
          was.file_last_modified === book.fileLastModified.toISOString() &&
          was.file_size === book.fileSize
        const match = same ? { id: was.id, seriesId: current.id } : await deletedBookFor(db, book, taken, trashSizes)
        if (match) taken.add(match.id)
        arrivals.set(bookUrl, match)
      }

      await together(async (trx, later) => {
        await trx
          .updateTable('series')
          .set({
            name: scanned.name,
            oneshot: scanned.oneshot ? 1 : 0,
            file_last_modified: scanned.fileLastModified.toISOString(),
            deleted_date: null,
            last_modified_date: now,
          })
          .where('id', '=', current.id)
          .execute()
        summary.seriesUpdated += 1

        for (const book of scanned.books) {
          const bookUrl = pathToFileURL(book.path).href
          const existingBook = liveByUrl.get(bookUrl)
          const modified = book.fileLastModified.toISOString()

          if (!existingBook) {
            await arrive(trx, later, current.id, book, arrivals.get(bookUrl) ?? null)
            continue
          }

          if (existingBook.file_last_modified === modified) continue

          await trx
            .updateTable('books')
            .set({ file_last_modified: modified, file_size: book.fileSize, last_modified_date: now })
            .where('id', '=', existingBook.id)
            .execute()
          // What analysis recorded no longer describes the file.
          await trx
            .updateTable('media')
            .set({ status: 'OUTDATED', last_modified_date: now })
            .where('book_id', '=', existingBook.id)
            .execute()
          summary.booksUpdated += 1
          if (events) {
            later.push(() =>
              announceBook(events, 'BookChanged', { bookId: existingBook.id, seriesId: current.id, libraryId }),
            )
          }
        }

        await sortBooks(trx, current.id, now)
        if (events) later.push(() => announceSeries(events, 'SeriesChanged', { seriesId: current.id, libraryId }))
      })

      // Only a series the scan changed is read again below. One that is as it was
      // costs a scan nothing more than the look at its folder.
      touched.add(current.id)
    }
  }

  // A series has no file of its own: what it is called, who published it and what
  // it is about come from its books' metadata documents. So a series the scan
  // touched is read again here, which is where the reference triggers it too. A
  // series that did not change is not read, so a scan over an unchanged library
  // still touches no book file at all. The cover that may sit in its folder is
  // picked up the same way, which is cheap when there is none.
  for (const seriesId of touched) {
    await refreshSeriesMetadata(db, seriesId)
    await refreshSeriesLocalArtwork(db, seriesId)
  }

  if (library.empty_trash_after_scan === 1) {
    await db.deleteFrom('books').where('library_id', '=', libraryId).where('deleted_date', 'is not', null).execute()
    await db.deleteFrom('series').where('library_id', '=', libraryId).where('deleted_date', 'is not', null).execute()

    // Empting the trash is also when a collection or read list that has lost
    // everything is removed, if the server is set to remove them.
    const cleaned = await cleanupEmptySets(db)
    summary.collectionsDeleted = cleaned.collectionsDeleted
    summary.readListsDeleted = cleaned.readListsDeleted
  }

  return summary
}
