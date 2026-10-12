/**
 * The arithmetic of reading an EPUB: which resource an address names, where in
 * the book a place in a chapter is, and how a chapter divides into pages.
 */

/** A position of a book, as the server lists them. */
export interface EpubPosition {
  href: string
  type?: string
  locations?: { progression?: number; position?: number; totalProgression?: number }
}

/** Where a reader is: a resource of the book, and how far into it, from 0 to 1. */
export interface EpubPlace {
  /** The resource's path inside the book, as positions name it. */
  path: string
  progression: number
}

const RESOURCE_MARKER = '/resource/'

/**
 * The path inside the book that a resource address names, without its fragment.
 *
 * The manifest gives whole addresses - `…/books/{id}/resource/OEBPS/ch1.xhtml` -
 * while positions and progress name the path after `resource/`.
 */
export function resourcePath(href: string): string {
  const withoutFragment = href.split('#')[0] ?? ''
  const at = withoutFragment.indexOf(RESOURCE_MARKER)
  const path = at === -1 ? withoutFragment : withoutFragment.slice(at + RESOURCE_MARKER.length)
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** The fragment of an address, without its `#`, or `undefined` when it has none. */
export function fragmentOf(href: string): string | undefined {
  const at = href.indexOf('#')
  if (at === -1 || at === href.length - 1) return undefined
  try {
    return decodeURIComponent(href.slice(at + 1))
  } catch {
    return href.slice(at + 1)
  }
}

/** Which chapter of the reading order an address belongs to, or -1 for none of them. */
export function chapterIndexOf(readingOrder: readonly { href?: string }[], href: string): number {
  const path = resourcePath(href)
  return readingOrder.findIndex(
    (link) => link.href !== undefined && resourcePath(link.href) === path,
  )
}

/**
 * The position of the book a place falls on: the last one of its resource that
 * starts at or before it.
 */
export function positionAt(
  positions: readonly EpubPosition[],
  place: EpubPlace,
): { position: number; totalProgression: number } | undefined {
  let found: EpubPosition | undefined
  for (const position of positions) {
    if (position.href !== place.path) continue
    // The first of a resource stands for a place before every position's start.
    if (found === undefined || (position.locations?.progression ?? 0) <= place.progression) {
      found = position
    }
  }
  if (found?.locations?.position === undefined) return undefined
  return {
    position: found.locations.position,
    totalProgression: found.locations.totalProgression ?? 0,
  }
}

/** How many pages a chapter laid out `contentWidth` wide makes, a page being `pageWidth`. */
export function pageCount(contentWidth: number, pageWidth: number): number {
  if (pageWidth <= 0) return 1
  // A hair over a whole number of pages is rounding, not another page.
  return Math.max(1, Math.ceil((contentWidth - 1) / pageWidth))
}

/** The page, from 0, that a progression through a chapter of `pages` pages falls on. */
export function pageAt(progression: number, pages: number): number {
  const page = Math.floor(progression * pages + 1e-6)
  return Math.min(Math.max(page, 0), pages - 1)
}

/** How far into a chapter of `pages` pages the start of a page is. */
export function progressionOf(page: number, pages: number): number {
  return pages <= 0 ? 0 : Math.min(Math.max(page / pages, 0), 1)
}

/** A whole percentage for showing how far through the book a reader is. */
export function percent(totalProgression: number): number {
  return Math.round(Math.min(Math.max(totalProgression, 0), 1) * 100)
}
