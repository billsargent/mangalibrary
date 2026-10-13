/**
 * Bringing back a book the library soft-deleted, when its file returns.
 *
 * A book is recognised by what is in its file, never by what the file is called:
 * a deleted book of the same size whose stored hash equals the hash of the file
 * the scan found is that book, wherever the file now sits. Restoring it keeps its
 * id, and with the id everything that hangs off it - read progress, metadata,
 * thumbnails, and its place in read lists.
 *
 * The file is only hashed when a deleted book of exactly its size has a hash to
 * compare with, so a scan that adds new books to a library with nothing in its
 * trash reads no file at all.
 */

import { pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { onThread } from '../threads/index.js'
import type { ScannedBook } from './library.js'

/** A soft-deleted book a file was matched to. */
export interface DeletedBook {
  id: string
  seriesId: string
}

/**
 * The deleted book this file is, or `null` when it is none the library knows.
 *
 * `taken` holds books already matched to another file in the same scan, so two
 * copies of one file do not both claim the same deleted book.
 */
export async function deletedBookFor(
  db: Kysely<DB>,
  file: ScannedBook,
  taken: ReadonlySet<string> = new Set(),
): Promise<DeletedBook | null> {
  const candidates = (
    await db
      .selectFrom('books')
      .select(['id', 'series_id', 'file_hash'])
      .where('deleted_date', 'is not', null)
      .where('file_size', '=', file.fileSize)
      .where('file_hash', 'is not', null)
      .where('file_hash', '!=', '')
      .execute()
  ).filter((row) => !taken.has(row.id))
  if (candidates.length === 0) return null

  let hash: string
  try {
    hash = await onThread('hashFile', { path: file.path })
  } catch {
    // A file that cannot be read is no known book; analysis will say what is wrong.
    return null
  }

  const match = candidates.find((row) => row.file_hash === hash)
  return match ? { id: match.id, seriesId: match.series_id } : null
}

/**
 * Un-delete a book and point it at the file the scan found.
 *
 * The file is the one the book was made from, so what analysis recorded still
 * describes it and nothing is marked outdated. A title that was only ever the
 * file's name follows the file to its new name; one that came from anywhere else
 * is left alone.
 */
export async function restoreBook(
  db: Kysely<DB>,
  bookId: string,
  target: { seriesId: string; libraryId: string },
  file: ScannedBook,
  now: string,
): Promise<void> {
  const before = await db.selectFrom('books').select('name').where('id', '=', bookId).executeTakeFirst()

  await db
    .updateTable('books')
    .set({
      series_id: target.seriesId,
      library_id: target.libraryId,
      name: file.name,
      url: pathToFileURL(file.path).href,
      file_last_modified: file.fileLastModified.toISOString(),
      file_size: file.fileSize,
      deleted_date: null,
      last_modified_date: now,
    })
    .where('id', '=', bookId)
    .execute()

  if (before && before.name !== file.name) {
    await db
      .updateTable('book_metadata')
      .set({ title: file.name, last_modified_date: now })
      .where('book_id', '=', bookId)
      .where('title_lock', '=', 0)
      .where('title', '=', before.name)
      .execute()
  }
}
