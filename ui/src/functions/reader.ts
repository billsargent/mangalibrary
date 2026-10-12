import { bookPageUrl } from '@/api/images'
import type { PageDto } from '@/generated/openapi'
import type { ReaderPage } from '@/types/reader'

/**
 * Image types every browser this application runs in can show.
 *
 * Anything else - JPEG XL, TIFF, a format an archive happens to hold - is asked for
 * as a JPEG, which the server converts to.
 */
const BROWSER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']

/** The pages of a book as the reader shows them, each with the address of its image. */
export function toReaderPages(bookId: string, pages: readonly PageDto[]): ReaderPage[] {
  return pages.map((page) => {
    const url = bookPageUrl(bookId, page.number) ?? ''
    return {
      number: page.number,
      width: page.width,
      height: page.height,
      mediaType: page.mediaType,
      fileName: page.fileName,
      url: BROWSER_IMAGE_TYPES.includes(page.mediaType.toLowerCase()) ? url : `${url}?convert=jpeg`,
    }
  })
}

/**
 * A book's title for a narrow space, with its series when the title does not name it.
 *
 * "Akira - 3 - Volume 3" for a book titled "Volume 3", but just "Akira Volume 3"
 * for a book whose own title already says which series it belongs to.
 */
export function bookTitleCompact(bookTitle: string, seriesTitle: string, number?: string): string {
  if (bookTitle.toLowerCase().includes(seriesTitle.toLowerCase())) return bookTitle
  return number === undefined
    ? `${seriesTitle} - ${bookTitle}`
    : `${seriesTitle} - ${number} - ${bookTitle}`
}

/** A page number kept inside the book, or `undefined` when it is not a page at all. */
export function clampPage(page: unknown, pageCount: number): number | undefined {
  const number = Number(page)
  if (!Number.isInteger(number) || number < 1 || number > pageCount) return undefined
  return number
}

/** The next value after `current` in a list, going round to the first after the last. */
export function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!
}
