/**
 * Editing several series or books at once.
 *
 * The form starts empty, and only what is filled in is applied: a field left
 * alone keeps whatever each item already has. The price is that a field cannot be
 * emptied for many items at once, which is what editing one item is for.
 */

/** What a series bulk edit can change. */
export interface SeriesBulkForm {
  publisher: string | null
  status: string | null
  readingDirection: string | null
  language: string | null
  ageRating: number | null
  genres: string[]
  tags: string[]
  sharingLabels: string[]
}

/** What a book bulk edit can change. */
export interface BookBulkForm {
  tags: string[]
  authors: { name: string; role: string }[]
}

export function emptySeriesBulkForm(): SeriesBulkForm {
  return {
    publisher: null,
    status: null,
    readingDirection: null,
    language: null,
    ageRating: null,
    genres: [],
    tags: [],
    sharingLabels: [],
  }
}

export function emptyBookBulkForm(): BookBulkForm {
  return { tags: [], authors: [] }
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * The update a filled-in form asks for: its filled fields, each with its lock.
 *
 * A field that is edited by hand is locked, as it is when one item is edited, so
 * that the next metadata refresh does not put the old value back.
 */
export function bulkPatch(form: object): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(form)) {
    if (!isFilled(value)) continue
    patch[key] = typeof value === 'string' ? value.trim() : value
    patch[`${key}Lock`] = true
  }
  return patch
}

/** The same update for each of several books, as the batch endpoint takes it. */
export function bulkBookPatches(
  bookIds: readonly string[],
  patch: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(bookIds.map((id) => [id, patch]))
}
