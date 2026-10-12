import { pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { naturalCompare } from '../media/kinds.js'
import { refreshSeriesLocalArtwork } from '../metadata/localArtwork.js'
import { refreshSeriesMetadata } from '../metadata/series.js'
import { cleanupEmptySets } from '../organisation/cleanup.js'
import { nextTsid } from '../tsid.js'
import { LibraryScanError, walkLibrary, type ScannedBook, type ScanSettings } from './library.js'

/** What a scan did, so a caller can report it. */
export interface ScanSummary {
  seriesCreated: number
  seriesUpdated: number
  seriesDeleted: number
  booksCreated: number
  booksUpdated: number
  booksDeleted: number
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

/** Add books to a series, with the metadata row each one needs. */
async function addBooks(
  db: Kysely<DB>,
  seriesId: string,
  libraryId: string,
  books: readonly ScannedBook[],
  now: string,
): Promise<number> {
  for (const book of books) {
    const id = nextTsid()
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
  return books.length
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
 * Scan a library and make the database match what is on disk.
 *
 * The walk is `walkLibrary`; this half decides what to write. A series or book
 * that is gone is soft-deleted rather than removed, so the trash bin holds it and
 * a returning series can be matched back to it - which is the hash-based restore
 * in `docs/SCANNING.md` and arrives with file hashing. A book whose file changed
 * has its media marked outdated, because whatever analysis recorded no longer
 * describes it.
 *
 * A walk that cannot proceed marks the library unavailable and throws; a walk
 * that succeeds clears the mark. When the library asks for it, the trash is
 * emptied at the end, which is the only thing that hard-deletes.
 */
export async function scanLibrary(
  db: Kysely<DB>,
  libraryId: string,
  options: { deep?: boolean } = {},
): Promise<ScanSummary> {
  const now = new Date().toISOString()
  const library = await db.selectFrom('libraries').selectAll().where('id', '=', libraryId).executeTakeFirst()
  if (!library) throw new Error(`library ${libraryId} does not exist`)

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
    await softDeleteBooks(
      db,
      books.map((row) => row.id),
      now,
    )
    await db.updateTable('series').set({ deleted_date: now, last_modified_date: now }).where('id', 'in', ids).execute()
    summary.seriesDeleted += ids.length
    summary.booksDeleted += books.length
  }

  for (const scanned of found) {
    const url = pathToFileURL(scanned.path).href
    const current = byUrl.get(url)

    if (!current) {
      const seriesId = nextTsid()
      await db
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
      await db
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
      summary.booksCreated += await addBooks(db, seriesId, libraryId, scanned.books, now)
      touched.add(seriesId)
      continue
    }

    const books = await db
      .selectFrom('books')
      .select(['id', 'name', 'url', 'file_last_modified', 'deleted_date'])
      .where('series_id', '=', current.id)
      .execute()
    const bookByUrl = new Map(books.map((row) => [row.url, row]))
    const scannedBookUrls = new Set(scanned.books.map((book) => pathToFileURL(book.path).href))

    const lost = books.filter((row) => row.deleted_date === null && !scannedBookUrls.has(row.url))
    const changed =
      current.file_last_modified !== scanned.fileLastModified.toISOString() || current.deleted_date !== null

    if (lost.length > 0) {
      await softDeleteBooks(
        db,
        lost.map((row) => row.id),
        now,
      )
      summary.booksDeleted += lost.length
      touched.add(current.id)
    }

    if (changed || lost.length > 0 || options.deep === true) {
      await db
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
        const existingBook = bookByUrl.get(pathToFileURL(book.path).href)
        if (!existingBook || existingBook.deleted_date !== null) continue

        const modified = book.fileLastModified.toISOString()
        if (existingBook.file_last_modified === modified) continue

        await db
          .updateTable('books')
          .set({ file_last_modified: modified, file_size: book.fileSize, last_modified_date: now })
          .where('id', '=', existingBook.id)
          .execute()
        // What analysis recorded no longer describes the file.
        await db
          .updateTable('media')
          .set({ status: 'OUTDATED', last_modified_date: now })
          .where('book_id', '=', existingBook.id)
          .execute()
        summary.booksUpdated += 1
      }

      const missingBooks = scanned.books.filter((book) => !bookByUrl.has(pathToFileURL(book.path).href))
      if (missingBooks.length > 0) {
        summary.booksCreated += await addBooks(db, current.id, libraryId, missingBooks, now)
      }
    }

    touched.add(current.id)
  }

  for (const seriesId of touched) await sortBooks(db, seriesId, now)

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
