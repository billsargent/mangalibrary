/**
 * Applying a metadata patch to what is stored.
 *
 * A patch is what a provider read out of a file - never a whole record - and
 * applying it means taking only the fields it carries, only when the user has not
 * locked them, and only when they would actually change. That last part matters
 * because a scan runs over the same files repeatedly and a timestamp that moves
 * every time would make every book look freshly modified.
 */

/** A person credited on a book or a series. */
export interface Author {
  name: string
  role: string
}

/** A link out of a book or a series, with the label the client shows. */
export interface WebLink {
  label: string
  url: string
}

/**
 * The parts of a book a provider can contribute.
 *
 * A caller can ask for a subset - renumbering a series only wants the number, for
 * instance - and a provider that contributes nothing else is then left alone.
 */
export const BOOK_METADATA_CAPABILITIES = [
  'TITLE',
  'SUMMARY',
  'NUMBER',
  'NUMBER_SORT',
  'RELEASE_DATE',
  'AUTHORS',
  'TAGS',
  'LINKS',
  'ISBN',
] as const

export type BookMetadataCapability = (typeof BOOK_METADATA_CAPABILITIES)[number]

/** What a provider read out of a book, with every field optional. */
export interface BookMetadataPatch {
  title?: string
  summary?: string
  number?: string
  numberSort?: number
  /** `YYYY-MM-DD`, which is what a release date is stored as. */
  releaseDate?: string
  authors?: readonly Author[]
  tags?: readonly string[]
  links?: readonly WebLink[]
  isbn?: string
}

/** The stored metadata of a book, and which of its fields a user has locked. */
export interface BookMetadataState {
  title: string
  summary: string
  number: string
  numberSort: number
  releaseDate: string | null
  isbn: string
  authors: readonly Author[]
  tags: readonly string[]
  links: readonly WebLink[]
  locks: {
    title: boolean
    summary: boolean
    number: boolean
    numberSort: boolean
    releaseDate: boolean
    isbn: boolean
    authors: boolean
    tags: boolean
    links: boolean
  }
}

/**
 * What to write, and only what changes.
 *
 * `values` are columns of `book_metadata`; the rest are child tables to replace
 * wholesale, because that is how they are stored and compared.
 */
export interface BookMetadataUpdate {
  values: {
    title?: string
    summary?: string
    number?: string
    number_sort?: number
    release_date?: string | null
    isbn?: string
  }
  authors?: readonly Author[]
  tags?: readonly string[]
  links?: readonly WebLink[]
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function sameAuthors(left: readonly Author[], right: readonly Author[]): boolean {
  return sameKeys(
    left.map((author) => `${author.role}\u0000${author.name}`),
    right.map((author) => `${author.role}\u0000${author.name}`),
  )
}

function sameLinks(left: readonly WebLink[], right: readonly WebLink[]): boolean {
  return sameKeys(
    left.map((link) => `${link.label}\u0000${link.url}`),
    right.map((link) => `${link.label}\u0000${link.url}`),
  )
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return sameKeys(left, right)
}

/**
 * Apply a patch to a book's metadata, honouring the locks and the capabilities
 * the caller asked for.
 *
 * A list is replaced as a whole rather than merged, because a provider reads the
 * whole list: a credit that disappeared from the file is a credit that should
 * disappear from the book. A locked list is left alone entirely. Lists are
 * compared as sets, so re-ordering credits in a file does not rewrite the book.
 */
export function applyBookPatch(
  state: BookMetadataState,
  patch: BookMetadataPatch,
  capabilities: readonly BookMetadataCapability[] = BOOK_METADATA_CAPABILITIES,
): BookMetadataUpdate {
  const update: BookMetadataUpdate = { values: {} }
  const wanted = new Set<BookMetadataCapability>(capabilities)

  if (wanted.has('TITLE') && patch.title !== undefined && !state.locks.title && patch.title !== state.title) {
    update.values.title = patch.title
  }
  if (wanted.has('SUMMARY') && patch.summary !== undefined && !state.locks.summary && patch.summary !== state.summary) {
    update.values.summary = patch.summary
  }
  if (wanted.has('NUMBER') && patch.number !== undefined && !state.locks.number && patch.number !== state.number) {
    update.values.number = patch.number
  }
  if (
    wanted.has('NUMBER_SORT') &&
    patch.numberSort !== undefined &&
    !state.locks.numberSort &&
    patch.numberSort !== state.numberSort
  ) {
    update.values.number_sort = patch.numberSort
  }
  if (
    wanted.has('RELEASE_DATE') &&
    patch.releaseDate !== undefined &&
    !state.locks.releaseDate &&
    patch.releaseDate !== (state.releaseDate ?? '')
  ) {
    update.values.release_date = patch.releaseDate
  }
  if (wanted.has('ISBN') && patch.isbn !== undefined && !state.locks.isbn && patch.isbn !== state.isbn) {
    update.values.isbn = patch.isbn
  }
  if (
    wanted.has('AUTHORS') &&
    patch.authors !== undefined &&
    !state.locks.authors &&
    !sameAuthors(state.authors, patch.authors)
  ) {
    update.authors = patch.authors
  }
  if (wanted.has('TAGS') && patch.tags !== undefined && !state.locks.tags && !sameTags(state.tags, patch.tags)) {
    update.tags = patch.tags
  }
  if (wanted.has('LINKS') && patch.links !== undefined && !state.locks.links && !sameLinks(state.links, patch.links)) {
    update.links = patch.links
  }

  return update
}

/** Whether an update would write anything at all. */
export function isEmptyUpdate(update: BookMetadataUpdate): boolean {
  return (
    Object.keys(update.values).length === 0 &&
    update.authors === undefined &&
    update.tags === undefined &&
    update.links === undefined
  )
}

/** The state a book has once an update has been written. */
function withBookUpdate(state: BookMetadataState, update: BookMetadataUpdate): BookMetadataState {
  return {
    ...state,
    title: update.values.title ?? state.title,
    summary: update.values.summary ?? state.summary,
    number: update.values.number ?? state.number,
    numberSort: update.values.number_sort ?? state.numberSort,
    releaseDate: update.values.release_date === undefined ? state.releaseDate : update.values.release_date,
    isbn: update.values.isbn ?? state.isbn,
    authors: update.authors ?? state.authors,
    tags: update.tags ?? state.tags,
    links: update.links ?? state.links,
  }
}

/**
 * Apply several patches to a book, in order.
 *
 * A book can carry more than one document - an EPUB keeps its own metadata and may
 * still hold a `ComicInfo.xml` - and the reference applies each document's patch in
 * turn, so that a later one wins where they disagree. Each is applied to what the
 * one before it decided, which is what keeps "only write what changes" true.
 */
export function applyBookPatches(
  state: BookMetadataState,
  patches: readonly BookMetadataPatch[],
  capabilities: readonly BookMetadataCapability[] = BOOK_METADATA_CAPABILITIES,
): BookMetadataUpdate {
  let current = state
  const merged: BookMetadataUpdate = { values: {} }

  for (const patch of patches) {
    const update = applyBookPatch(current, patch, capabilities)
    current = withBookUpdate(current, update)
    Object.assign(merged.values, update.values)
    if (update.authors !== undefined) merged.authors = update.authors
    if (update.tags !== undefined) merged.tags = update.tags
    if (update.links !== undefined) merged.links = update.links
  }

  return merged
}

/** What a provider read about a series out of its books, with every field optional. */
export interface SeriesMetadataPatch {
  status?: string
  title?: string
  titleSort?: string
  summary?: string
  readingDirection?: string
  ageRating?: number
  publisher?: string
  language?: string
  genres?: readonly string[]
  totalBookCount?: number
}

/** The stored metadata of a series, and which of its fields a user has locked. */
export interface SeriesMetadataState {
  status: string
  title: string
  titleSort: string
  summary: string
  readingDirection: string | null
  ageRating: number | null
  publisher: string
  language: string
  totalBookCount: number | null
  genres: readonly string[]
  locks: {
    status: boolean
    title: boolean
    titleSort: boolean
    summary: boolean
    readingDirection: boolean
    ageRating: boolean
    publisher: boolean
    language: boolean
    totalBookCount: boolean
    genres: boolean
  }
}

/** What to write for a series, and only what changes. */
export interface SeriesMetadataUpdate {
  values: {
    status?: string
    title?: string
    title_sort?: string
    summary?: string
    reading_direction?: string | null
    age_rating?: number | null
    publisher?: string
    language?: string
    total_book_count?: number | null
  }
  genres?: readonly string[]
}

/**
 * Apply a patch to a series' metadata, honouring the locks.
 *
 * A series patch always comes from its books, so what an aggregation decided is
 * subject to the same rules a scan is: a locked field is the user's.
 */
export function applySeriesPatch(state: SeriesMetadataState, patch: SeriesMetadataPatch): SeriesMetadataUpdate {
  const update: SeriesMetadataUpdate = { values: {} }

  if (patch.status !== undefined && !state.locks.status && patch.status !== state.status) {
    update.values.status = patch.status
  }
  if (patch.title !== undefined && !state.locks.title && patch.title !== state.title) {
    update.values.title = patch.title
  }
  if (patch.titleSort !== undefined && !state.locks.titleSort && patch.titleSort !== state.titleSort) {
    update.values.title_sort = patch.titleSort
  }
  if (patch.summary !== undefined && !state.locks.summary && patch.summary !== state.summary) {
    update.values.summary = patch.summary
  }
  if (
    patch.readingDirection !== undefined &&
    !state.locks.readingDirection &&
    patch.readingDirection !== state.readingDirection
  ) {
    update.values.reading_direction = patch.readingDirection
  }
  if (patch.ageRating !== undefined && !state.locks.ageRating && patch.ageRating !== state.ageRating) {
    update.values.age_rating = patch.ageRating
  }
  if (patch.publisher !== undefined && !state.locks.publisher && patch.publisher !== state.publisher) {
    update.values.publisher = patch.publisher
  }
  if (patch.language !== undefined && !state.locks.language && patch.language !== state.language) {
    update.values.language = patch.language
  }
  if (
    patch.totalBookCount !== undefined &&
    !state.locks.totalBookCount &&
    patch.totalBookCount !== state.totalBookCount
  ) {
    update.values.total_book_count = patch.totalBookCount
  }
  if (patch.genres !== undefined && !state.locks.genres && !sameTags(state.genres, patch.genres)) {
    update.genres = patch.genres
  }

  return update
}

/** Whether a series update would write anything at all. */
export function isEmptySeriesUpdate(update: SeriesMetadataUpdate): boolean {
  return Object.keys(update.values).length === 0 && update.genres === undefined
}

/** The state a series has once an update has been written. */
function withSeriesUpdate(state: SeriesMetadataState, update: SeriesMetadataUpdate): SeriesMetadataState {
  return {
    ...state,
    status: update.values.status ?? state.status,
    title: update.values.title ?? state.title,
    titleSort: update.values.title_sort ?? state.titleSort,
    summary: update.values.summary ?? state.summary,
    readingDirection:
      update.values.reading_direction === undefined ? state.readingDirection : update.values.reading_direction,
    ageRating: update.values.age_rating === undefined ? state.ageRating : update.values.age_rating,
    publisher: update.values.publisher ?? state.publisher,
    language: update.values.language ?? state.language,
    totalBookCount:
      update.values.total_book_count === undefined ? state.totalBookCount : update.values.total_book_count,
    genres: update.genres ?? state.genres,
  }
}

/**
 * Apply several patches to a series, in order.
 *
 * A series is described by its books and by its own sidecars, and the reference
 * applies one patch per source in turn, so that a source that knows more wins: the
 * books first, then the sidecar that names the collection, then the oneshot rule
 * that takes everything from the single book the series is.
 */
export function applySeriesPatches(
  state: SeriesMetadataState,
  patches: readonly SeriesMetadataPatch[],
): SeriesMetadataUpdate {
  let current = state
  const merged: SeriesMetadataUpdate = { values: {} }

  for (const patch of patches) {
    const update = applySeriesPatch(current, patch)
    current = withSeriesUpdate(current, update)
    Object.assign(merged.values, update.values)
    if (update.genres !== undefined) merged.genres = update.genres
  }

  return merged
}
