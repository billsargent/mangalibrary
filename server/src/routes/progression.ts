/**
 * What a reader's place in a book says about how far through it they are.
 *
 * A Readium reader reports a locator - a resource and how far into it - rather
 * than a page. The book's page and whether it is finished are worked out from
 * that here, as the reference works them out, so that a book read to its end in
 * an EPUB reader is a book that has been read.
 */

/** A position of a book, as analysis stored it. */
export interface StoredPosition {
  href?: unknown
  type?: unknown
  koboSpan?: unknown
  locations?: { progression?: unknown; position?: unknown; totalProgression?: unknown }
}

export interface LocatorProgress {
  page: number
  completed: boolean
  /** The locator to store: the reader's, with what the server knows better. */
  locator: Record<string, unknown>
}

/** A locator that cannot be turned into progress, and why. */
export class ProgressionError extends Error {}

/** The share of a book past which it counts as read, as the reference has it. */
const READ_AT = 0.99

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The resource a locator names: no fragment, and decoded. */
function resourceOf(href: string): string {
  const withoutFragment = href.split('#')[0] ?? ''
  try {
    return decodeURIComponent(withoutFragment)
  } catch {
    return withoutFragment
  }
}

/**
 * Progress through a book of pages: the locator's position is the page.
 */
export function pagedProgress(locator: Record<string, unknown>, pageCount: number): LocatorProgress {
  const locations = (locator.locations ?? {}) as { position?: unknown }
  const position = numberOf(locations.position)
  if (position === null || !Number.isInteger(position) || position < 1 || position > pageCount) {
    throw new ProgressionError(
      `Page argument (${String(locations.position)}) must be within 1 and book page count (${pageCount})`,
    )
  }
  return { page: position, completed: position === pageCount, locator }
}

/**
 * Progress through an EPUB: the locator is matched to one of the book's positions.
 *
 * The position at exactly the locator's progression is taken, and otherwise the
 * last one before it - provided there is one after it too, which is how a
 * progression outside the resource is told apart from one between two positions.
 * A resource with a single position matches it wherever the reader is in it.
 */
export function epubProgress(
  locator: Record<string, unknown>,
  positions: readonly StoredPosition[],
  pageCount: number,
): LocatorProgress {
  const href = typeof locator.href === 'string' ? resourceOf(locator.href) : ''
  const locations = (locator.locations ?? {}) as Record<string, unknown>
  const progression = numberOf(locations.progression)
  if (progression === null) throw new ProgressionError('location.progression is required')

  const inResource = positions.filter((position) => position.href === href)
  if (inResource.length === 0) throw new ProgressionError(`Resource does not exist in book: ${href}`)

  const at = (position: StoredPosition): number => numberOf(position.locations?.progression) ?? 0
  let matched = inResource.length === 1 ? inResource[0] : inResource.find((position) => at(position) === progression)
  if (matched === undefined) {
    const before = inResource.filter((position) => at(position) < progression).at(-1)
    const after = inResource.find((position) => at(position) > progression)
    // Past the last position of a resource is still in it: the last one stands.
    matched = before !== undefined && (after !== undefined || progression <= 1) ? before : undefined
  }
  if (matched === undefined) throw new ProgressionError('Invalid progression')

  const totalProgression = numberOf(matched.locations?.totalProgression)
  return {
    page: totalProgression === null ? 0 : Math.round(pageCount * totalProgression),
    completed: totalProgression !== null && totalProgression >= READ_AT,
    locator: {
      ...locator,
      // The type the book has for the resource, not the one the reader sent.
      ...(typeof matched.type === 'string' ? { type: matched.type } : {}),
      ...(locator.koboSpan === undefined && typeof matched.koboSpan === 'string' ? { koboSpan: matched.koboSpan } : {}),
      // A reader's own idea of the total can be wrong; the book's positions are not.
      locations: { ...locations, ...(totalProgression === null ? {} : { totalProgression }) },
    },
  }
}
