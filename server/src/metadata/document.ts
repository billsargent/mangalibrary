/**
 * Reading a metadata document out of a book's file.
 *
 * Both the book refresh and the series refresh need this, and both must treat an
 * unreadable file as something to report rather than to throw about: a malformed
 * archive should mark its analysis, not stop a series from being refreshed.
 */

import { openBook, type BookContents } from '../media/index.js'
import { comicInfoEntry } from './comicinfo.js'

export type DocumentRead = { status: 'ok'; xml: string } | { status: 'skipped' | 'failed'; reason: string }

/** Read `ComicInfo.xml` out of the book at a path, without ever throwing. */
export async function readComicInfo(path: string): Promise<DocumentRead> {
  let book: BookContents | null = null
  try {
    book = await openBook(path)
    const entry = comicInfoEntry(book.files)
    if (entry === null) return { status: 'skipped', reason: 'the book carries no ComicInfo.xml' }

    return { status: 'ok', xml: (await book.readResource(entry)).toString('utf8') }
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message }
  } finally {
    book?.close()
  }
}
