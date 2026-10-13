/**
 * Removing a book's or a series' files from disk because somebody asked for it.
 *
 * After the reference's `BookLifecycle.deleteBookFiles` and
 * `SeriesLifecycle.deleteSeriesFiles`: the file goes, the artwork found beside it
 * goes, the folder goes when that leaves it empty, and each of those is written in
 * the history, because a file that was deleted on request is the one thing nobody
 * can get back by scanning again.
 *
 * Two things are stricter here than there. A folder is removed with `rmdir`, which
 * cannot remove one that holds anything, so nothing that was not asked for is ever
 * lost with it. And a library's own folder is never removed, however empty: the
 * library is still configured to be there.
 */

import { constants } from 'node:fs'
import { access, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { insideRootOnDisk } from '../media/scan.js'
import { sortBooks } from '../scan/reconcile.js'
import { nextTsid } from '../tsid.js'
import { bookFilePath, confinedPath, findBookRecord } from './files.js'

/** What a deletion needs from a logger. */
interface DeleteLogger {
  info(context: Record<string, unknown>, message: string): void
  warn(context: Record<string, unknown>, message: string): void
}

/** What was marked deleted, so that whoever is looking can be told. */
export interface Deleted {
  bookIds: string[]
  seriesId: string | null
}

const BY_REQUEST = 'File was deleted by user request'
const EMPTY_FOLDER = 'Folder was deleted because it was empty'

const writable = (path: string): Promise<boolean> =>
  access(path, constants.W_OK).then(
    () => true,
    () => false,
  )

async function record(
  db: Kysely<DB>,
  type: 'BOOK_FILE_DELETED' | 'SERIES_FOLDER_DELETED',
  ids: { bookId?: string; seriesId: string },
  properties: Record<string, string>,
): Promise<void> {
  await db
    .insertInto('historical_events')
    .values({
      id: nextTsid(),
      type,
      book_id: ids.bookId ?? null,
      series_id: ids.seriesId,
      properties: JSON.stringify(properties),
      timestamp: new Date().toISOString(),
    })
    .execute()
}

/** The artwork files found beside a book or a series, as its rows name them. */
async function artworkFiles(db: Kysely<DB>, owner: 'BOOK' | 'SERIES', ownerId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('thumbnails')
    .select('url')
    .where('owner_type', '=', owner)
    .where('owner_id', '=', ownerId)
    .where('type', '=', 'SIDECAR')
    .where('url', 'is not', null)
    .execute()
  return rows.flatMap((row) => (row.url === null ? [] : [row.url]))
}

/**
 * Remove artwork files. A row says where a file is, and a row can be wrong - an
 * imported database, a library whose folder moved - so nothing outside the library
 * is removed on a row's word.
 */
async function removeArtwork(root: string, files: readonly string[], log: DeleteLogger): Promise<void> {
  for (const file of files) {
    if (!(await insideRootOnDisk(root, file))) {
      log.warn({ file }, 'left an artwork file alone: it is outside its library')
      continue
    }
    await unlink(file).then(
      () => log.info({ file }, 'deleted file'),
      (error: unknown) => log.warn({ file, err: String(error) }, 'could not remove an artwork file'),
    )
  }
}

/**
 * Remove a folder if it is empty, and say so in the history. Returns whether it went.
 * The library's own folder stays whatever is in it.
 */
async function removeIfEmpty(
  db: Kysely<DB>,
  root: string,
  folder: string,
  seriesId: string,
  log: DeleteLogger,
): Promise<boolean> {
  const [resolvedRoot, resolved] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(folder).catch(() => null),
  ])
  if (resolvedRoot === null || resolved === null) return false
  if (resolved === resolvedRoot || !(await insideRootOnDisk(root, resolved))) return false

  // `rmdir` refuses a folder that holds anything, so this cannot take a file with it.
  const removed = await rmdir(resolved).then(
    () => true,
    () => false,
  )
  if (!removed) return false

  log.info({ folder: resolved }, 'deleted directory')
  await record(db, 'SERIES_FOLDER_DELETED', { seriesId }, { reason: EMPTY_FOLDER, name: resolved })
  return true
}

/** One book's file and artwork, and its folder if that empties it. Null when nothing was done. */
async function removeBook(db: Kysely<DB>, log: DeleteLogger, bookId: string): Promise<string | null> {
  const book = await findBookRecord(db, bookId)
  if (book === null) return null

  const path = await bookFilePath(book)
  if (path === null) {
    log.info({ bookId, url: book.url }, 'cannot delete book file, path does not exist')
    return null
  }
  if (!(await writable(path))) {
    log.info({ bookId, path }, 'cannot delete book file, path is not writable')
    return null
  }

  const artwork = await artworkFiles(db, 'BOOK', bookId)
  const removed = await unlink(path).then(
    () => true,
    (error: unknown) => {
      log.warn({ bookId, path, err: String(error) }, 'could not remove a book file')
      return false
    },
  )
  // A book whose file is still there is still a book: the next scan would only bring it back.
  if (!removed) return null

  log.info({ file: path }, 'deleted file')
  await record(db, 'BOOK_FILE_DELETED', { bookId, seriesId: book.seriesId }, { reason: BY_REQUEST, name: path })
  await removeArtwork(book.root, artwork, log)
  await removeIfEmpty(db, book.root, dirname(path), book.seriesId, log)

  const now = new Date().toISOString()
  await db.updateTable('books').set({ deleted_date: now, last_modified_date: now }).where('id', '=', bookId).execute()
  return bookId
}

/**
 * Delete a book's file. A oneshot is a series that is one book, so deleting the
 * book deletes the series with it.
 */
export async function deleteBookFiles(db: Kysely<DB>, log: DeleteLogger, bookId: string): Promise<Deleted> {
  const row = await db
    .selectFrom('books')
    .innerJoin('series', 'series.id', 'books.series_id')
    .select(['books.series_id', 'series.oneshot'])
    .where('books.id', '=', bookId)
    .where('books.deleted_date', 'is', null)
    .executeTakeFirst()
  if (!row) return { bookIds: [], seriesId: null }
  if (row.oneshot === 1) return deleteSeriesFiles(db, log, row.series_id)

  const removed = await removeBook(db, log, bookId)
  if (removed === null) return { bookIds: [], seriesId: null }

  // The books that are left close ranks, and the series counts one fewer.
  const now = new Date().toISOString()
  await sortBooks(db, row.series_id, now)

  // A series with no book and no folder is what the next scan would put in the trash.
  // The reference leaves it listed, empty, until then; here it goes with its last book.
  const left = await db
    .selectFrom('series')
    .innerJoin('libraries', 'libraries.id', 'series.library_id')
    .select(['series.book_count', 'series.url', 'libraries.root'])
    .where('series.id', '=', row.series_id)
    .executeTakeFirst()
  if (left && left.book_count === 0 && (await confinedPath(left.root, left.url, 'directory')) === null) {
    await db
      .updateTable('series')
      .set({ deleted_date: now, last_modified_date: now })
      .where('id', '=', row.series_id)
      .execute()
    return { bookIds: [removed], seriesId: row.series_id }
  }
  return { bookIds: [removed], seriesId: null }
}

/** Delete every file of a series, the artwork beside it, and its folder if that empties it. */
export async function deleteSeriesFiles(db: Kysely<DB>, log: DeleteLogger, seriesId: string): Promise<Deleted> {
  const nothing: Deleted = { bookIds: [], seriesId: null }
  const series = await db
    .selectFrom('series')
    .innerJoin('libraries', 'libraries.id', 'series.library_id')
    .select(['series.url', 'series.oneshot', 'libraries.root'])
    .where('series.id', '=', seriesId)
    .where('series.deleted_date', 'is', null)
    .executeTakeFirst()
  if (!series) return nothing

  // A oneshot's place is its file; any other series' is its folder.
  const place = await confinedPath(series.root, series.url, series.oneshot === 1 ? 'file' : 'directory')
  if (place === null) {
    log.info({ seriesId, url: series.url }, 'cannot delete series folder, path does not exist')
    return nothing
  }
  if (!(await writable(place))) {
    log.info({ seriesId, path: place }, 'cannot delete series folder, path is not writable')
    return nothing
  }

  const artwork = await artworkFiles(db, 'SERIES', seriesId)
  const books = await db
    .selectFrom('books')
    .select('id')
    .where('series_id', '=', seriesId)
    .where('deleted_date', 'is', null)
    .execute()

  const bookIds: string[] = []
  for (const book of books) {
    const removed = await removeBook(db, log, book.id)
    if (removed !== null) bookIds.push(removed)
  }
  await removeArtwork(series.root, artwork, log)
  // The last book out may have taken the folder with it; if artwork was keeping it, it goes now.
  if (series.oneshot !== 1) await removeIfEmpty(db, series.root, place, seriesId, log)

  const now = new Date().toISOString()
  await db
    .updateTable('series')
    .set({ deleted_date: now, last_modified_date: now, book_count: books.length - bookIds.length })
    .where('id', '=', seriesId)
    .execute()
  return { bookIds, seriesId }
}
