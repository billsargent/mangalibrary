/**
 * Reading a book's metadata documents out of its file.
 *
 * Both the book refresh and the series refresh need this, and both must treat an
 * unreadable file as something to report rather than to throw about: a malformed
 * archive should mark its analysis, not stop a series from being refreshed.
 *
 * One pass over the container reads every document it holds, because opening a
 * book costs a full read of its file.
 */

import { openBook, type BookContents } from '../media/index.js'
import { comicInfoEntry } from './comicinfo.js'

/** The metadata documents a book carries. */
export interface BookDocuments {
  /** `ComicInfo.xml`, or null when the book carries none. */
  comicInfo: string | null
  /** An EPUB's package document, or null for anything that is not an EPUB. */
  packageDocument: string | null
}

export type BookDocumentsRead =
  { status: 'ok'; documents: BookDocuments } | { status: 'skipped' | 'failed'; reason: string }

/** Read every metadata document out of the book at a path, without ever throwing. */
export async function readBookDocuments(path: string): Promise<BookDocumentsRead> {
  let book: BookContents | null = null
  try {
    book = await openBook(path)

    const entry = comicInfoEntry(book.files)
    const comicInfo = entry === null ? null : (await book.readResource(entry)).toString('utf8')
    const packageDocument = book.kind === 'EPUB' ? (book.epub?.packageDocument ?? null) : null

    if (comicInfo === null && packageDocument === null) {
      return { status: 'skipped', reason: 'the book carries no metadata document' }
    }
    return { status: 'ok', documents: { comicInfo, packageDocument } }
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message }
  } finally {
    book?.close()
  }
}
