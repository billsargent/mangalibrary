/**
 * Taking pages out of a comic archive.
 *
 * A duplicate page is a page that exists in two books - or twice in one - and
 * removing it means writing the book again without it. The file is rewritten beside
 * the original, checked, and only then put in its place, so a failure anywhere
 * leaves the library the book it already had.
 *
 * Everything here is deliberately careful: this is the only thing in the server
 * that rewrites a file a person owns. The checks are the ones the reference makes -
 * the file must not have changed since it was scanned, the book must be a comic
 * archive that analysed, the pages to remove must account for exactly the pages that
 * go, and the rewritten file must hold every page and file that stays.
 */

import { randomBytes } from 'node:crypto'
import { rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { sql, type Kysely } from 'kysely'

import { bookFilePath, findBookRecord, updatedTime } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { nextTsid } from '../tsid.js'
import { zipStream } from '../zip.js'
import { analyzeBook } from './analyze.js'
import { MEDIA_TYPES, openBook } from './index.js'

/** A page to take out of a book, as the API describes it. */
export interface PageToRemove {
  fileName: string
  mediaType: string
  fileHash: string
  fileSize: number | null
  /** One-based, as the API numbers pages. */
  pageNumber: number
}

/** What a removal did, or why it did nothing. */
export type RemovalStatus =
  /** The file was rewritten; `pages` says how many went. */
  | 'REMOVED'
  /** The book, or its file, is not there any more. */
  | 'GONE'
  /** The file changed since it was scanned: a scan will notice, and this job stops. */
  | 'CHANGED'
  /** The book is not an analysed comic archive, which is the only thing this can rewrite. */
  | 'UNSUPPORTED'
  /** The pages named are not the pages the book has, so nothing was touched. */
  | 'MISMATCH'
  /** The rewritten file did not pass its checks; the original is untouched. */
  | 'FAILED'

export interface RemovalResult {
  status: RemovalStatus
  pages: number
  /** Whether the page a poster is made from was among them. */
  removedFirstPage: boolean
}

/**
 * The media this can rewrite: a comic archive, which is the one the reference can
 * rewrite too - its pages are the files inside it.
 *
 * Both spellings are accepted, because a database carried over from Komga holds the
 * reference's own media type and one this server scanned holds the short one.
 */
const REWRITABLE: readonly string[] = [MEDIA_TYPES.ZIP, 'application/vnd.comicbook+zip']

/** Remove the pages named, replacing the book's file with one that holds the rest. */
export async function removeHashedPages(
  db: Kysely<DB>,
  bookId: string,
  pages: readonly PageToRemove[],
): Promise<RemovalResult> {
  const nothing = (status: RemovalStatus): RemovalResult => ({ status, pages: 0, removedFirstPage: false })

  if (pages.length === 0) return nothing('MISMATCH')

  const record = await findBookRecord(db, bookId)
  if (record === null) return nothing('GONE')

  const path = await bookFilePath(record)
  if (path === null) return nothing('GONE')

  const book = await db
    .selectFrom('books')
    .select(['file_last_modified', 'series_id'])
    .where('id', '=', bookId)
    .executeTakeFirst()
  const media = await db
    .selectFrom('media')
    .select(['status', 'media_type'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()

  // A book whose file changed since it was scanned is not the book this job was
  // queued for, so it is left alone: the scan will analyse it and hash its pages
  // again. Nothing is worse than a removal that removes the wrong page.
  const info = await stat(path).catch(() => null)
  if (info === null) return nothing('GONE')
  if (book === undefined || updatedTime(info).toISOString() !== book.file_last_modified) return nothing('CHANGED')
  if (media?.status !== 'READY' || media.media_type === null || !REWRITABLE.includes(media.media_type)) {
    return nothing('UNSUPPORTED')
  }

  const stored = await db
    .selectFrom('media_page')
    .select(['number', 'file_name', 'media_type', 'file_hash'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()
  const files = await db.selectFrom('media_file').select('file_name').where('book_id', '=', bookId).execute()

  /** Whether a page of the book is one of the pages to remove. */
  const isRemoved = (page: { number: number; file_name: string; media_type: string; file_hash: string }): boolean =>
    pages.some(
      (candidate) =>
        candidate.pageNumber === page.number &&
        candidate.fileName === page.file_name &&
        candidate.mediaType === page.media_type &&
        candidate.fileHash === page.file_hash,
    )

  const kept = stored.filter((page) => !isRemoved(page))
  if (kept.length + pages.length !== stored.length) return nothing('MISMATCH')

  // The pages that stay, and then whatever the book holds that is not a page - a
  // document, a cover - in the order the reference writes them. A page's entry is
  // not written twice, and the pages that go are not written at all.
  const pageNames = new Set(stored.map((page) => page.file_name))
  const others = files.map((file) => file.file_name).filter((name) => !pageNames.has(name))
  const names = [...new Set([...kept.map((page) => page.file_name), ...others])]

  const temporary = join(dirname(path), `${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeTemporaryBook(path, temporary, names)

    const rewritten = await openBook(temporary, 'ZIP')
    try {
      const rewrittenPages = new Set(rewritten.pages.map((page) => page.fileName))
      const rewrittenFiles = new Set(rewritten.files.map((file) => file.fileName))
      const holdsEverything = names.every((name) => rewrittenPages.has(name) || rewrittenFiles.has(name))
      if (!holdsEverything || rewritten.pages.length !== kept.length) return nothing('FAILED')
    } finally {
      rewritten.close()
    }

    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => undefined)
    return nothing('FAILED')
  }

  // The file the library now has is analysed again, and the pages that stayed keep
  // the hashes they had: hashing a whole book again because one page was removed
  // would be wasteful, and a page's hash does not change when its neighbours go.
  const replacement = await stat(path).catch(() => null)
  const analysis = await analyzeBook(db, bookId, path)
  if (analysis.status !== 'READY') return nothing('FAILED')

  const now = new Date().toISOString()
  await db
    .updateTable('books')
    .set({
      file_size: replacement?.size ?? info.size,
      file_last_modified: replacement === null ? book.file_last_modified : updatedTime(replacement).toISOString(),
      last_modified_date: now,
    })
    .where('id', '=', bookId)
    .execute()

  const hashes = new Map(stored.map((page) => [page.file_name, page.file_hash]))
  for (const page of kept) {
    const hash = hashes.get(page.file_name)
    if (hash === undefined || hash === '') continue
    await db
      .updateTable('media_page')
      .set({ file_hash: hash })
      .where('book_id', '=', bookId)
      .where('file_name', '=', page.file_name)
      .execute()
  }

  // A hash somebody judged remembers how many times a page carrying it has been
  // removed, which is what tells them whether removing the rest is worth it.
  for (const hash of new Set(pages.map((page) => page.fileHash))) {
    if (hash === '') continue
    await db
      .updateTable('page_hash')
      .set({ delete_count: sql<number>`delete_count + 1`, last_modified_date: now })
      .where('hash', '=', hash)
      .execute()
  }

  await db
    .insertInto('historical_events')
    .values(
      pages.map((page) => ({
        id: nextTsid(),
        type: 'DUPLICATE_PAGE_DELETED',
        book_id: bookId,
        series_id: book.series_id,
        properties: JSON.stringify({
          name: record.url,
          'page number': String(page.pageNumber),
          'page file name': page.fileName,
          'page file hash': page.fileHash,
          'page file size': String(page.fileSize ?? ''),
          'page media type': page.mediaType,
        }),
        timestamp: now,
      })),
    )
    .execute()

  return { status: 'REMOVED', pages: pages.length, removedFirstPage: pages.some((page) => page.pageNumber === 1) }
}

/**
 * Queue removing pages from a book.
 *
 * The job is keyed by the book, as the reference keys it: a book is rewritten once,
 * and a second request for the same book replaces what was queued rather than
 * rewriting it twice.
 */
export async function queuePageRemoval(
  db: Kysely<DB>,
  bookId: string,
  pages: readonly PageToRemove[],
  priority: number = JOB_PRIORITY.DEFAULT,
): Promise<void> {
  if (pages.length === 0) return

  await enqueueJob(db, {
    type: 'RemoveHashedPages',
    uniqueKey: `REMOVE_HASHED_PAGES_${bookId}`,
    priority,
    payload: { bookId, pages },
  })
}

/** The pages of a library whose hash is marked for removal, grouped by book. */
export async function pagesToRemoveAutomatically(
  db: Kysely<DB>,
  libraryId: string,
): Promise<{ bookId: string; pages: PageToRemove[] }[]> {
  const rows = await db
    .selectFrom('media_page')
    .innerJoin('page_hash', 'page_hash.hash', 'media_page.file_hash')
    .innerJoin('books', 'books.id', 'media_page.book_id')
    .select([
      'media_page.book_id',
      'media_page.number',
      'media_page.file_name',
      'media_page.media_type',
      'media_page.file_hash',
      'media_page.file_size',
    ])
    .where('books.library_id', '=', libraryId)
    .where('books.deleted_date', 'is', null)
    .where('page_hash.action', '=', 'DELETE_AUTO')
    .orderBy('media_page.book_id')
    .orderBy('media_page.number')
    .execute()

  const byBook = new Map<string, PageToRemove[]>()
  for (const row of rows) {
    const pages = byBook.get(row.book_id) ?? []
    pages.push({
      fileName: row.file_name,
      mediaType: row.media_type,
      fileHash: row.file_hash,
      fileSize: row.file_size,
      pageNumber: row.number,
    })
    byBook.set(row.book_id, pages)
  }

  return [...byBook].map(([bookId, pages]) => ({ bookId, pages }))
}

/** Write a new archive holding the named entries of a book, next to the book. */
async function writeTemporaryBook(source: string, target: string, names: readonly string[]): Promise<void> {
  const book = await openBook(source)
  try {
    const entries: { name: string; bytes: Buffer }[] = []
    for (const name of names) {
      const index = book.pages.findIndex((page) => page.fileName === name)
      entries.push({ name, bytes: index >= 0 ? await book.readPage(index + 1) : await book.readResource(name) })
    }

    // The archive is written whole before anything replaces a file: a half-written
    // book is worse than a removal that did not happen.
    const chunks: Buffer[] = []
    for await (const chunk of zipStream(entries)) chunks.push(chunk as Buffer)
    await writeFile(target, Buffer.concat(chunks))
  } finally {
    book.close()
  }
}
