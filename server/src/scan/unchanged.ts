import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { refreshBookMetadata } from '../metadata/refresh.js'
import { MEDIA_TYPES } from '../media/index.js'
import { openZip } from '../media/zip.js'

/**
 * Whether a CBZ whose file time changed still holds the pages analysis found.
 *
 * A file's time moves for many reasons that leave a book as it was: it was copied,
 * a backup touched it, a tagging tool rewrote its ComicInfo. Reading the book again
 * for that costs a whole analysis, and the reference avoids it only by hashing the
 * whole file. A ZIP lists its entries, with their sizes, in a directory at its end:
 * reading that is a few kilobytes, and if it names every page analysis stored, at
 * the size it stored, and nothing else besides the files analysis also saw, the
 * pages - and so the analysis, the covers and every reader's place - still hold.
 * The reference hashes the whole file for the same answer.
 *
 * Only a ZIP that analysed as READY, with every page's size known, can be judged
 * this way; anything else is read again, as before. What a tagging tool changes is
 * not pages, so the caller reads the book's metadata again either way.
 */
export async function pagesUnchanged(db: Kysely<DB>, bookId: string, path: string): Promise<boolean> {
  const media = await db
    .selectFrom('media')
    .select(['status', 'media_type', 'page_count'])
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (media?.status !== 'READY' || media.media_type !== MEDIA_TYPES.ZIP || media.page_count === 0) return false

  const pages = await db
    .selectFrom('media_page')
    .select(['file_name', 'file_size'])
    .where('book_id', '=', bookId)
    .execute()
  if (pages.length !== media.page_count || pages.some((page) => page.file_size === null)) return false
  const others = await db.selectFrom('media_file').select('file_name').where('book_id', '=', bookId).execute()

  let container
  try {
    container = await openZip(path)
  } catch {
    return false
  }
  try {
    const expected = new Set([...pages.map((page) => page.file_name), ...others.map((file) => file.file_name)])
    if (container.entries.length !== expected.size) return false
    if (!container.entries.every((name) => expected.has(name))) return false
    return pages.every((page) => container.sizes.get(page.file_name) === page.file_size)
  } finally {
    container.close()
  }
}

/**
 * Look at a book a scan found touched: one whose pages are as analysed keeps its
 * analysis and has its metadata read again (a tagging tool changes ComicInfo, not
 * pages); any other is marked OUTDATED, for the caller to have analysed.
 */
export async function checkTouchedBook(db: Kysely<DB>, bookId: string): Promise<'KEPT' | 'OUTDATED' | 'GONE'> {
  const record = await findBookRecord(db, bookId)
  const path = record === null ? null : await bookFilePath(record)
  // A file that is gone is the next scan's to find; nothing is marked here.
  if (path === null) return 'GONE'

  if (await pagesUnchanged(db, bookId, path)) {
    await refreshBookMetadata(db, bookId, { path })
    return 'KEPT'
  }
  await db
    .updateTable('media')
    .set({ status: 'OUTDATED', last_modified_date: new Date().toISOString() })
    .where('book_id', '=', bookId)
    .execute()
  return 'OUTDATED'
}
