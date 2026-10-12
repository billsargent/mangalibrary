import type { RouteLocationRaw } from 'vue-router'

/**
 * Where a book is read: the reader for books made of images, or the one for books
 * made of text.
 *
 * `incognito` reads without recording progress. A book opened from a read list
 * carries the list along, so that "next book" means the next one in that list.
 */
export function bookReaderRoute(
  bookId: string,
  epub: boolean,
  incognito: boolean = false,
  readListId?: string,
): RouteLocationRaw {
  const query: Record<string, string> = { incognito: String(incognito) }
  if (readListId) {
    query.context = 'READLIST'
    query.contextId = readListId
  }
  return {
    name: epub ? '/book.[id].read-epub' : '/book.[id].read',
    params: { id: bookId },
    query,
  }
}
