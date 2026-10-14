/**
 * Reading one page of a book, wherever that is best done.
 *
 * A page of a CBZ or an EPUB is a read of one entry from disk, which waits on the
 * disk and holds nothing up. A page of a CBR is unpacked, and a page of a PDF is
 * drawn: both are computation that would stop the server answering anybody else
 * until it was done. Those two are read on a reader thread.
 */

import { onReader } from '../threads/index.js'
import { unpackPage } from '../threads/page-bytes.js'
import { containerOf, openBook } from './index.js'

/** A page's bytes, or why there are none: the file would not open, or has no such page. */
export type PageRead = { bytes: Buffer; mediaType: string } | { failed: 'OPEN' | 'PAGE' }

export async function readBookPage(path: string, pageNumber: number): Promise<PageRead> {
  const kind = await containerOf(path)
  if (kind === 'RAR' || kind === 'PDF') {
    const read = await onReader(path, 'readPage', { path, pageNumber })
    if (!(read instanceof ArrayBuffer)) return read
    return unpackPage(read)
  }

  let book
  try {
    book = await openBook(path)
  } catch {
    return { failed: 'OPEN' }
  }
  try {
    const page = book.pages[pageNumber - 1]
    if (page === undefined) return { failed: 'PAGE' }
    return { bytes: await book.readPage(pageNumber), mediaType: page.mediaType }
  } catch {
    return { failed: 'PAGE' }
  } finally {
    book.close()
  }
}
