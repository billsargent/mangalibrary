/**
 * Hashing a book: the operations behind the `HashBook`, `HashBookKoreader` and
 * `HashBookPages` jobs.
 *
 * A job is queued once and may run long after the library settings changed, so
 * each operation asks the library again before doing any work, and says what it
 * decided rather than assuming it was still wanted. That is what the reference
 * does, and it is the only way an operator turning hashing off takes effect
 * without emptying the queue.
 */

import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { MEDIA_TYPES } from '../media/index.js'
import { onThread } from '../threads/index.js'
import { HASHED_PAGES_AT_EACH_END, pagesToHash } from './hashes.js'

/**
 * The media the reference hashes pages of.
 *
 * A comic archive is a list of images, so its pages are the images themselves. A
 * PDF's pages are drawn when they are read, and an EPUB's are not the unit a
 * reader navigates, so neither is hashed - which is the reference's choice too.
 */
const PAGE_HASHED_MEDIA_TYPES: readonly string[] = [MEDIA_TYPES.ZIP]

/** What a book-hashing operation did, and why it did nothing. */
export type HashOutcome =
  | { status: 'HASHED'; hash: string }
  | { status: 'PAGES_HASHED'; pages: number }
  | { status: 'SKIPPED'; reason: 'GONE' | 'NO_FILE' | 'DISABLED' | 'ALREADY_HASHED' | 'NO_PAGES' }

/** Whether a library asks for each kind of hashing. */
export interface HashSettings {
  files: boolean
  pages: boolean
  koreader: boolean
}

export async function hashSettings(db: Kysely<DB>, libraryId: string): Promise<HashSettings> {
  const row = await db
    .selectFrom('libraries')
    .select(['hash_files', 'hash_pages', 'hash_koreader'])
    .where('id', '=', libraryId)
    .executeTakeFirst()

  return {
    files: row?.hash_files === 1,
    pages: row?.hash_pages === 1,
    koreader: row?.hash_koreader === 1,
  }
}

/** A book's row and its file, which every operation below needs first. */
async function bookAndPath(
  db: Kysely<DB>,
  bookId: string,
): Promise<{ libraryId: string; path: string; fileHash: string | null; koreaderHash: string | null } | null> {
  const record = await findBookRecord(db, bookId)
  if (record === null) return null

  const path = await bookFilePath(record)
  if (path === null) return null

  const row = await db
    .selectFrom('books')
    .select(['file_hash', 'file_hash_koreader'])
    .where('id', '=', bookId)
    .executeTakeFirst()

  return {
    libraryId: record.libraryId,
    path,
    fileHash: row?.file_hash ?? null,
    koreaderHash: row?.file_hash_koreader ?? null,
  }
}

/**
 * Hash a book's file and remember it, unless the library no longer wants that or
 * the book already has a hash.
 */
export async function hashBookFile(db: Kysely<DB>, bookId: string): Promise<HashOutcome> {
  const book = await bookAndPath(db, bookId)
  if (book === null) return { status: 'SKIPPED', reason: 'GONE' }

  const settings = await hashSettings(db, book.libraryId)
  if (!settings.files) return { status: 'SKIPPED', reason: 'DISABLED' }
  if (book.fileHash !== null && book.fileHash !== '') return { status: 'SKIPPED', reason: 'ALREADY_HASHED' }

  const hash = await onThread('hashFile', { path: book.path })
  await db.updateTable('books').set({ file_hash: hash }).where('id', '=', bookId).execute()
  return { status: 'HASHED', hash }
}

/**
 * Hash a book's file the way KOReader does, and remember it.
 *
 * A KOReader reader recognises a book on the server by this value, which is why it
 * is computed from the file rather than from anything this server knows.
 */
export async function hashBookKoreader(db: Kysely<DB>, bookId: string): Promise<HashOutcome> {
  const book = await bookAndPath(db, bookId)
  if (book === null) return { status: 'SKIPPED', reason: 'GONE' }

  const settings = await hashSettings(db, book.libraryId)
  if (!settings.koreader) return { status: 'SKIPPED', reason: 'DISABLED' }
  if (book.koreaderHash !== null && book.koreaderHash !== '') return { status: 'SKIPPED', reason: 'ALREADY_HASHED' }

  const hash = await onThread('hashKoreader', { path: book.path })
  await db.updateTable('books').set({ file_hash_koreader: hash }).where('id', '=', bookId).execute()
  return { status: 'HASHED', hash }
}

/** A page of a book that will be hashed, as the media table holds it. */
interface PageToHash {
  number: number
  fileName: string
}

/**
 * Hash the pages of a book that have no hash yet.
 *
 * Only the first and last few pages are hashed, because a duplicate is a whole book
 * and its edges are enough to recognise it - so hashing a library stays quick. A page
 * that already has a hash keeps it, so a book whose page count grew is not hashed
 * again from the start.
 */
export async function hashBookPages(db: Kysely<DB>, bookId: string): Promise<HashOutcome> {
  const book = await bookAndPath(db, bookId)
  if (book === null) return { status: 'SKIPPED', reason: 'GONE' }

  const settings = await hashSettings(db, book.libraryId)
  if (!settings.pages) return { status: 'SKIPPED', reason: 'DISABLED' }

  const media = await db
    .selectFrom('media')
    .select(['status', 'page_count'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (media?.status !== 'READY') return { status: 'SKIPPED', reason: 'NO_PAGES' }

  const rows = await db
    .selectFrom('media_page')
    .select(['number', 'file_name', 'file_hash'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()
  if (rows.length === 0) return { status: 'SKIPPED', reason: 'NO_PAGES' }

  const wanted = new Set(pagesToHash(rows.length))
  const toHash: PageToHash[] = rows
    .filter((row) => wanted.has(row.number) && row.file_hash === '')
    .map((row) => ({ number: row.number, fileName: row.file_name }))
  if (toHash.length === 0) return { status: 'PAGES_HASHED', pages: 0 }

  // The book is read on a thread, all its pages at one opening; what was learned
  // is written here.
  const hashes = await onThread('hashPages', { path: book.path, pages: toHash.map((page) => page.number) })
  for (const { number, hash } of hashes) {
    await db
      .updateTable('media_page')
      .set({ file_hash: hash })
      .where('book_id', '=', bookId)
      .where('number', '=', number)
      .execute()
  }

  return { status: 'PAGES_HASHED', pages: toHash.length }
}

/** Book ids of a library whose file hash is still to be computed, in series order. */
export async function booksNeedingFileHash(db: Kysely<DB>, libraryId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('books')
    .select(['id', 'file_hash'])
    .where('library_id', '=', libraryId)
    .where('deleted_date', 'is', null)
    .orderBy('series_id')
    .orderBy('number')
    .execute()

  return rows.filter((row) => row.file_hash === null || row.file_hash === '').map((row) => row.id)
}

/** Book ids of a library whose KOReader hash is still to be computed. */
export async function booksNeedingKoreaderHash(db: Kysely<DB>, libraryId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('books')
    .select(['id', 'file_hash_koreader'])
    .where('library_id', '=', libraryId)
    .where('deleted_date', 'is', null)
    .orderBy('series_id')
    .orderBy('number')
    .execute()

  return rows.filter((row) => row.file_hash_koreader === null || row.file_hash_koreader === '').map((row) => row.id)
}

/**
 * Book ids of a library with pages still to hash.
 *
 * A book wants hashing when fewer of its pages carry a hash than it should have:
 * up to the first and last few, or all of them when it has fewer than that. Asking
 * that question of the rows rather than of the library's settings means a book
 * analysed after the last scan is picked up without the scanner knowing about pages.
 */
export async function booksNeedingPageHash(db: Kysely<DB>, libraryId: string): Promise<string[]> {
  const books = await db
    .selectFrom('books')
    .innerJoin('media', 'media.book_id', 'books.id')
    .select(['books.id', 'media.page_count'])
    .where('books.library_id', '=', libraryId)
    .where('books.deleted_date', 'is', null)
    .where('media.status', '=', 'READY')
    .where('media.media_type', 'in', PAGE_HASHED_MEDIA_TYPES)
    .execute()

  const hashed = await db
    .selectFrom('media_page')
    .innerJoin('books', 'books.id', 'media_page.book_id')
    .select(['media_page.book_id', 'media_page.file_hash'])
    .where('books.library_id', '=', libraryId)
    .execute()

  const hashesByBook = new Map<string, number>()
  for (const row of hashed) {
    if (row.file_hash === '') continue
    hashesByBook.set(row.book_id, (hashesByBook.get(row.book_id) ?? 0) + 1)
  }

  return books
    .filter((book) => {
      const wanted = Math.min(book.page_count, HASHED_PAGES_AT_EACH_END * 2)
      return (hashesByBook.get(book.id) ?? 0) < wanted
    })
    .map((book) => book.id)
}
