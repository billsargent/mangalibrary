/**
 * Giving a book's file the extension of what it is, which a library's "repair
 * extensions" asks for.
 *
 * A RAR named `.cbz` is common - a CBR renamed by hand, or by a tool that thought the
 * two were the same - and other programs reading the folder go by the name. Analysis
 * knows what the file is (`containerOf` in `media/index.ts`); this renames it to match,
 * as the reference's `BookConverter.repairExtension` does: `.cbr` for a RAR, `.cbz` for
 * a ZIP, `.pdf`, `.epub`. An EPUB that analysed as a plain ZIP is left alone - it is
 * still an EPUB to anything that reads EPUBs - and a file of the new name already
 * there is never overwritten. Nothing is deleted: the file is renamed, and the book
 * keeps its id, its progress and everything else.
 */
import { rename, stat } from 'node:fs/promises'
import { dirname, extname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'
import { bookFilePath, findBookRecord, updatedTime } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { MEDIA_TYPES } from './kinds.js'

export type RepairStatus =
  | 'REPAIRED'
  /** The library no longer asks for it. */
  | 'DISABLED'
  /** The book or its file is no longer there. */
  | 'GONE'
  /** Already named for what it is, or an EPUB that analysed as a ZIP. */
  | 'MATCHES'
  /** Not analysed, or of a kind with no extension to give it. */
  | 'UNSUPPORTED'
  /** The file is not the one that was analysed; the next scan will look at it. */
  | 'CHANGED'
  /** A file of the new name is already beside it, and is not overwritten. */
  | 'EXISTS'

export interface RepairResult {
  status: RepairStatus
  from?: string
  to?: string
}

/** The extension a file of a media type is given, as the reference gives it. */
function extensionFor(mediaType: string): string | null {
  if (mediaType.startsWith(MEDIA_TYPES.RAR)) return 'cbr'
  if (mediaType === MEDIA_TYPES.ZIP) return 'cbz'
  if (mediaType === MEDIA_TYPES.PDF) return 'pdf'
  if (mediaType === MEDIA_TYPES.EPUB) return 'epub'
  return null
}

/** Rename a book's file to the extension of what analysis found it to be. */
export async function repairExtension(db: Kysely<DB>, bookId: string): Promise<RepairResult> {
  const record = await findBookRecord(db, bookId)
  if (record === null) return { status: 'GONE' }
  const library = await db
    .selectFrom('libraries')
    .select('repair_extensions')
    .where('id', '=', record.libraryId)
    .executeTakeFirst()
  if (library?.repair_extensions !== 1) return { status: 'DISABLED' }

  const path = await bookFilePath(record)
  if (path === null) return { status: 'GONE' }
  const media = await db
    .selectFrom('media')
    .select(['status', 'media_type'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (media?.status !== 'READY' || media.media_type === null) return { status: 'UNSUPPORTED' }
  const wanted = extensionFor(media.media_type)
  if (wanted === null) return { status: 'UNSUPPORTED' }

  const actual = extname(path).slice(1).toLowerCase()
  if (actual === wanted) return { status: 'MATCHES' }
  if (actual === 'epub' && media.media_type === MEDIA_TYPES.ZIP) return { status: 'MATCHES' }

  const book = await db.selectFrom('books').select('file_last_modified').where('id', '=', bookId).executeTakeFirst()
  const info = await stat(path).catch(() => null)
  if (info === null || book === undefined) return { status: 'GONE' }
  if (updatedTime(info).toISOString() !== book.file_last_modified) return { status: 'CHANGED' }

  const destination = join(dirname(path), `${parse(path).name}.${wanted}`)
  if ((await stat(destination).catch(() => null)) !== null) return { status: 'EXISTS' }

  await rename(path, destination)
  const moved = await stat(destination)
  const now = new Date().toISOString()
  await db
    .updateTable('books')
    .set({
      url: pathToFileURL(destination).href,
      file_last_modified: updatedTime(moved).toISOString(),
      last_modified_date: now,
    })
    .where('id', '=', bookId)
    .execute()
  return { status: 'REPAIRED', from: path, to: destination }
}

/** The analysed books of a library asking for repair whose extension is not what they are. */
export async function booksToRepair(db: Kysely<DB>, libraryId: string): Promise<string[]> {
  const library = await db
    .selectFrom('libraries')
    .select('repair_extensions')
    .where('id', '=', libraryId)
    .executeTakeFirst()
  if (library?.repair_extensions !== 1) return []

  const rows = await db
    .selectFrom('books')
    .innerJoin('media', 'media.book_id', 'books.id')
    .select(['books.id', 'books.url', 'media.media_type'])
    .where('books.library_id', '=', libraryId)
    .where('books.deleted_date', 'is', null)
    .where('media.status', '=', 'READY')
    .execute()
  return rows
    .filter((row) => {
      const wanted = row.media_type === null ? null : extensionFor(row.media_type)
      if (wanted === null) return false
      const actual = extname(decodeURIComponent(row.url)).slice(1).toLowerCase()
      return actual !== wanted && !(actual === 'epub' && row.media_type === MEDIA_TYPES.ZIP)
    })
    .map((row) => row.id)
}
