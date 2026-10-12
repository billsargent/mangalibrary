import { openBook } from '../media/index.js'
import { mediaTypeFor } from '../media/kinds.js'

/**
 * The bytes of a book's poster, from its first page or its cover.
 *
 * It needs the file and nothing else, so it can run on a worker thread.
 */
export async function posterOf(path: string): Promise<{ bytes: Buffer; mediaType: string } | null> {
  let book: Awaited<ReturnType<typeof openBook>> | null = null
  try {
    book = await openBook(path)

    if (book.kind === 'EPUB') {
      const cover = book.epub?.cover ?? null
      // A reflowable EPUB has no page that is an image, so its cover is the only
      // thing a poster can be made of; a fixed-layout one can use its first page.
      if (cover !== null) return { bytes: await book.readResource(cover), mediaType: mediaTypeFor(cover) }
      if (book.epub?.divinaCompatible === true) {
        return { bytes: await book.readPage(1), mediaType: book.pages[0]?.mediaType ?? 'image/jpeg' }
      }
      return null
    }

    const page = book.pages[0]
    if (page === undefined) return null
    return { bytes: await book.readPage(1), mediaType: page.mediaType }
  } catch {
    return null
  } finally {
    book?.close()
  }
}
