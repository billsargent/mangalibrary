/**
 * Turning a CBR into a CBZ, which is what a library's "convert to CBZ" asks for.
 *
 * A RAR can only be read by unpacking, and nothing but its owner's tools can
 * write one; a ZIP is read an entry at a time and rewritten freely. So a library
 * may ask for its CBRs to be rewritten as CBZs, once, and read as those from
 * then on. The reference does the same in `BookConverter.convertToCbz`, and this
 * follows it step for step.
 *
 * The CBR is the only copy of the book until the CBZ has been written, read back
 * and found to hold everything, so nothing is removed before that - and a
 * conversion that cannot be checked leaves the CBR exactly as it was.
 */

import { randomBytes } from 'node:crypto'
import { rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord, updatedTime } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { onThread } from '../threads/index.js'
import { nextTsid } from '../tsid.js'
import { analyzeBook } from './analyze.js'
import { MEDIA_TYPES } from './index.js'

export type ConversionStatus =
  | 'CONVERTED'
  /** The library no longer asks for it, which it may have stopped doing since the job was queued. */
  | 'DISABLED'
  /** The book or its file is no longer there. */
  | 'GONE'
  /** The file is not the one that was scanned; the next scan will look at it. */
  | 'CHANGED'
  /** Not an analysed RAR. */
  | 'UNSUPPORTED'
  /** A CBZ of that name is already beside it, and is not overwritten. */
  | 'EXISTS'
  /** It failed before, and is not tried again until the server restarts. */
  | 'FAILED_BEFORE'
  /** The new file could not be written or did not hold the whole book. The CBR is untouched. */
  | 'FAILED'

export interface ConversionResult {
  status: ConversionStatus
  /** The file there was and the file there is, when it was converted. */
  from?: string
  to?: string
}

/**
 * Books whose conversion failed, so that every scan does not try them again.
 * Kept in memory, as the reference keeps it: a restart is a fresh look.
 */
const failedBefore = new Set<string>()

/** Forget which conversions failed, which a test needs between cases. */
export function forgetFailedConversions(): void {
  failedBefore.clear()
}

/** Whether a media type is a RAR, as this server or the reference records it. */
export function isRarMediaType(mediaType: string | null): boolean {
  // The reference records the version too: `application/x-rar-compressed; version=4`.
  return mediaType !== null && mediaType.startsWith(MEDIA_TYPES.RAR)
}

/** Rewrite a book's CBR as a CBZ beside it, and point the book at the CBZ. */
export async function convertBookToCbz(db: Kysely<DB>, bookId: string): Promise<ConversionResult> {
  const record = await findBookRecord(db, bookId)
  if (record === null) return { status: 'GONE' }

  const library = await db
    .selectFrom('libraries')
    .select(['convert_to_cbz', 'analyze_dimensions'])
    .where('id', '=', record.libraryId)
    .executeTakeFirst()
  if (library?.convert_to_cbz !== 1) return { status: 'DISABLED' }
  if (failedBefore.has(bookId)) return { status: 'FAILED_BEFORE' }

  const path = await bookFilePath(record)
  if (path === null) return { status: 'GONE' }

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

  const info = await stat(path).catch(() => null)
  if (info === null || book === undefined) return { status: 'GONE' }
  if (updatedTime(info).toISOString() !== book.file_last_modified) return { status: 'CHANGED' }
  if (media?.status !== 'READY' || !isRarMediaType(media.media_type)) return { status: 'UNSUPPORTED' }

  const destination = join(dirname(path), `${parse(path).name}.cbz`)
  if ((await stat(destination).catch(() => null)) !== null) return { status: 'EXISTS' }

  const pages = await db
    .selectFrom('media_page')
    .select(['file_name', 'media_type', 'file_hash'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()
  const files = await db.selectFrom('media_file').select('file_name').where('book_id', '=', bookId).execute()
  // The pages in reading order, then whatever else the book holds, each once.
  const names = [...new Set([...pages.map((page) => page.file_name), ...files.map((file) => file.file_name)])]

  const temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`
  const fail = async (...leftovers: string[]): Promise<ConversionResult> => {
    for (const leftover of leftovers) await unlink(leftover).catch(() => undefined)
    failedBefore.add(bookId)
    return { status: 'FAILED' }
  }

  // Unpacking and writing is a thread's work. The new file is written under a name
  // no scan takes for a book, and takes its own name only once it is whole.
  const written = await onThread('convertToZip', { source: path, target: temporary, names }).catch(() => ({
    ok: false,
  }))
  if (!written.ok) return fail(temporary)
  try {
    await rename(temporary, destination)
  } catch {
    return fail(temporary)
  }

  // The new file has to be a book with every page the old one had before the old
  // one goes. Analysing it writes the book's media rows from it; if it is found
  // wanting, they are written again from the CBR, which is still the book.
  const analysis = await analyzeBook(db, bookId, destination, { analyzeDimensions: library.analyze_dimensions === 1 })
  const converted = await db
    .selectFrom('media_page')
    .select(['file_name', 'media_type'])
    .where('book_id', '=', bookId)
    .execute()
  const has = new Set(converted.map((page) => `${page.media_type} ${page.file_name}`))
  const whole =
    analysis.status === 'READY' &&
    analysis.mediaType === MEDIA_TYPES.ZIP &&
    pages.every((page) => has.has(`${page.media_type} ${page.file_name}`))
  if (!whole) {
    await analyzeBook(db, bookId, path, { analyzeDimensions: library.analyze_dimensions === 1 })
    return fail(destination)
  }

  const removed = await unlink(path).then(
    () => true,
    () => false,
  )

  const replacement = await stat(destination)
  const now = new Date().toISOString()
  await db
    .updateTable('books')
    .set({
      url: pathToFileURL(destination).href,
      file_size: replacement.size,
      file_last_modified: updatedTime(replacement).toISOString(),
      // The hashes are of the file, and the file is another one.
      file_hash: null,
      file_hash_koreader: null,
      last_modified_date: now,
    })
    .where('id', '=', bookId)
    .execute()

  // A page is the same page in either archive, so what was known of it is kept:
  // hashing a whole library's pages again because the wrapping changed would be waste.
  for (const page of pages) {
    if (page.file_hash === '') continue
    await db
      .updateTable('media_page')
      .set({ file_hash: page.file_hash })
      .where('book_id', '=', bookId)
      .where('file_name', '=', page.file_name)
      .execute()
  }

  const event = (type: 'BOOK_FILE_DELETED' | 'BOOK_CONVERTED', properties: Record<string, string>) => ({
    id: nextTsid(),
    type,
    book_id: bookId,
    series_id: book.series_id,
    properties: JSON.stringify(properties),
    timestamp: now,
  })
  await db
    .insertInto('historical_events')
    .values([
      ...(removed
        ? [event('BOOK_FILE_DELETED', { name: path, reason: 'File was deleted after conversion to CBZ' })]
        : []),
      event('BOOK_CONVERTED', { name: destination, 'former file': path }),
    ])
    .execute()

  return { status: 'CONVERTED', from: path, to: destination }
}

/** The analysed RAR books of a library that asks for conversion, which is none when it does not. */
export async function booksToConvert(db: Kysely<DB>, libraryId: string): Promise<string[]> {
  const library = await db
    .selectFrom('libraries')
    .select('convert_to_cbz')
    .where('id', '=', libraryId)
    .executeTakeFirst()
  if (library?.convert_to_cbz !== 1) return []

  const rows = await db
    .selectFrom('books')
    .innerJoin('media', 'media.book_id', 'books.id')
    .select('books.id')
    .where('books.library_id', '=', libraryId)
    .where('books.deleted_date', 'is', null)
    .where('media.status', '=', 'READY')
    .where('media.media_type', 'like', `${MEDIA_TYPES.RAR}%`)
    .execute()
  return rows.map((row) => row.id).filter((id) => !failedBefore.has(id))
}
