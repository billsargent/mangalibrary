/**
 * DTOs for the content browsing endpoints (series, books and their metadata).
 *
 * Shapes are taken field-for-field from the vendored OpenAPI document. Row
 * interfaces mirror the database columns; mappers only translate naming and
 * booleans, never invent values. Fields Komga derives from data we do not model
 * yet are filled with the documented "absent" value and noted in
 * `docs/COMPATIBILITY.md`.
 */

export interface AuthorDto {
  name: string
  role: string
}

export interface WebLinkDto {
  label: string
  url: string
}

export interface AlternateTitleDto {
  label: string
  title: string
}

export interface LockedFields {
  locked: boolean
}

export interface SeriesMetadataDto {
  status: string
  statusLock: boolean
  title: string
  titleLock: boolean
  titleSort: string
  titleSortLock: boolean
  publisher: string
  publisherLock: boolean
  language: string
  languageLock: boolean
  ageRating: number | null
  ageRatingLock: boolean
  readingDirection: string | null
  readingDirectionLock: boolean
  summary: string
  summaryLock: boolean
  totalBookCount: number | null
  totalBookCountLock: boolean
  sharingLabels: string[]
  sharingLabelsLock: boolean
  tags: string[]
  tagsLock: boolean
  genres: string[]
  genresLock: boolean
  links: WebLinkDto[]
  linksLock: boolean
  alternateTitles: AlternateTitleDto[]
  alternateTitlesLock: boolean
  created: string
  lastModified: string
}

export interface BookMetadataAggregationDto {
  summary: string
  summaryNumber: string
  releaseDate: string | null
  authors: AuthorDto[]
  tags: string[]
  created: string
  lastModified: string
}

export interface SeriesDto {
  id: string
  libraryId: string
  name: string
  url: string
  oneshot: boolean
  booksCount: number
  booksReadCount: number
  booksUnreadCount: number
  booksInProgressCount: number
  deleted: boolean
  created: string
  lastModified: string
  fileLastModified: string
  metadata: SeriesMetadataDto
  booksMetadata: BookMetadataAggregationDto
}

export interface MediaDto {
  mediaType: string
  status: string
  pagesCount: number
  comment: string
  mediaProfile: string
  epubDivinaCompatible: boolean
  epubIsKepub: boolean
}

export interface BookMetadataDto {
  title: string
  titleLock: boolean
  summary: string
  summaryLock: boolean
  number: string
  numberLock: boolean
  numberSort: number
  numberSortLock: boolean
  releaseDate: string | null
  releaseDateLock: boolean
  authors: AuthorDto[]
  authorsLock: boolean
  tags: string[]
  tagsLock: boolean
  isbn: string
  isbnLock: boolean
  links: WebLinkDto[]
  linksLock: boolean
  created: string
  lastModified: string
}

export interface ReadProgressDto {
  page: number
  completed: boolean
  deviceId: string | null
  deviceName: string | null
  readDate: string | null
  created: string
  lastModified: string
}

export interface BookDto {
  id: string
  seriesId: string
  seriesTitle: string
  libraryId: string
  name: string
  url: string
  number: number
  oneshot: boolean
  deleted: boolean
  created: string
  lastModified: string
  fileLastModified: string
  fileHash: string
  size: string
  sizeBytes: number
  media: MediaDto
  metadata: BookMetadataDto
  readProgress?: ReadProgressDto
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface SeriesRow {
  id: string
  library_id: string
  name: string
  url: string
  oneshot: number
  deleted_date: string | null
  created_date: string
  last_modified_date: string
  file_last_modified: string
}

export interface SeriesMetadataRow {
  series_id: string
  status: string
  status_lock: number
  title: string
  title_lock: number
  title_sort: string
  title_sort_lock: number
  publisher: string
  publisher_lock: number
  language: string
  language_lock: number
  age_rating: number | null
  age_rating_lock: number
  reading_direction: string | null
  reading_direction_lock: number
  summary: string
  summary_lock: number
  total_book_count: number | null
  total_book_count_lock: number
  sharing_labels_lock: number
  tags_lock: number
  genres_lock: number
  links_lock: number
  alternate_titles_lock: number
  created_date: string
  last_modified_date: string
}

export interface BookMetadataAggregationRow {
  series_id: string
  summary: string
  summary_number: string
  release_date: string | null
  created_date: string
  last_modified_date: string
}

export interface BookRow {
  id: string
  series_id: string
  library_id: string
  name: string
  url: string
  file_last_modified: string
  file_size: number
  file_hash: string | null
  number: number
  oneshot: number
  deleted_date: string | null
  created_date: string
  last_modified_date: string
}

export interface BookMetadataRow {
  book_id: string
  title: string
  title_lock: number
  number: string
  number_lock: number
  number_sort: number
  number_sort_lock: number
  release_date: string | null
  release_date_lock: number
  summary: string
  summary_lock: number
  isbn: string
  isbn_lock: number
  age_rating: number | null
  reading_direction: string | null
  authors_lock: number
  tags_lock: number
  links_lock: number
  created_date: string
  last_modified_date: string
}

export interface MediaRow {
  book_id: string
  media_type: string | null
  status: string
  comment: string | null
  page_count: number
}

export interface ReadProgressRow {
  user_id: string
  book_id: string
  page: number
  completed: number
  read_date: string | null
  device_id: string | null
  device_name: string | null
  created_date: string
  last_modified_date: string
}

/** Related list-valued metadata, loaded in bulk to avoid N+1 queries. */
export interface SeriesExtras {
  tags: string[]
  genres: string[]
  links: WebLinkDto[]
  alternateTitles: AlternateTitleDto[]
  sharingLabels: string[]
}

export interface BookExtras {
  authors: AuthorDto[]
  tags: string[]
  links: WebLinkDto[]
}

export function emptySeriesExtras(): SeriesExtras {
  return { tags: [], genres: [], links: [], alternateTitles: [], sharingLabels: [] }
}

export function emptyBookExtras(): BookExtras {
  return { authors: [], tags: [], links: [] }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toSeriesMetadataDto(row: SeriesMetadataRow, extras: SeriesExtras): SeriesMetadataDto {
  return {
    status: row.status,
    statusLock: row.status_lock === 1,
    title: row.title,
    titleLock: row.title_lock === 1,
    titleSort: row.title_sort,
    titleSortLock: row.title_sort_lock === 1,
    publisher: row.publisher,
    publisherLock: row.publisher_lock === 1,
    language: row.language,
    languageLock: row.language_lock === 1,
    ageRating: row.age_rating,
    ageRatingLock: row.age_rating_lock === 1,
    readingDirection: row.reading_direction,
    readingDirectionLock: row.reading_direction_lock === 1,
    summary: row.summary,
    summaryLock: row.summary_lock === 1,
    totalBookCount: row.total_book_count,
    totalBookCountLock: row.total_book_count_lock === 1,
    sharingLabels: extras.sharingLabels,
    sharingLabelsLock: row.sharing_labels_lock === 1,
    tags: extras.tags,
    tagsLock: row.tags_lock === 1,
    genres: extras.genres,
    genresLock: row.genres_lock === 1,
    links: extras.links,
    linksLock: row.links_lock === 1,
    alternateTitles: extras.alternateTitles,
    alternateTitlesLock: row.alternate_titles_lock === 1,
    created: row.created_date,
    lastModified: row.last_modified_date,
  }
}

export function toBookMetadataAggregationDto(
  row: BookMetadataAggregationRow | undefined,
  authors: AuthorDto[],
  tags: string[],
): BookMetadataAggregationDto {
  return {
    summary: row?.summary ?? '',
    summaryNumber: row?.summary_number ?? '',
    releaseDate: row?.release_date ?? null,
    authors,
    tags,
    created: row?.created_date ?? '',
    lastModified: row?.last_modified_date ?? '',
  }
}

export interface SeriesCounts {
  booksCount: number
  booksReadCount: number
  booksInProgressCount: number
}

export function toSeriesDto(
  row: SeriesRow,
  metadata: SeriesMetadataRow,
  aggregation: BookMetadataAggregationDto,
  counts: SeriesCounts,
  extras: SeriesExtras,
): SeriesDto {
  return {
    id: row.id,
    libraryId: row.library_id,
    name: row.name,
    url: row.url,
    oneshot: row.oneshot === 1,
    booksCount: counts.booksCount,
    booksReadCount: counts.booksReadCount,
    booksUnreadCount: Math.max(0, counts.booksCount - counts.booksReadCount - counts.booksInProgressCount),
    booksInProgressCount: counts.booksInProgressCount,
    deleted: row.deleted_date !== null,
    created: row.created_date,
    lastModified: row.last_modified_date,
    fileLastModified: row.file_last_modified,
    metadata: toSeriesMetadataDto(metadata, extras),
    booksMetadata: aggregation,
  }
}

const MEDIA_PROFILES: Record<string, string> = {
  'application/vnd.comicbook+zip': 'DIVINA',
  'application/vnd.comicbook-rar': 'DIVINA',
  'application/x-cb7': 'DIVINA',
  'application/x-cbt': 'DIVINA',
  'application/epub+zip': 'EPUB',
  'application/x-mobipocket-ebook': 'EPUB',
  'application/pdf': 'PDF',
}

export function mediaProfileOf(mediaType: string): string {
  return MEDIA_PROFILES[mediaType] ?? 'DIVINA'
}

export function toMediaDto(row: MediaRow | undefined): MediaDto {
  const mediaType = row?.media_type ?? ''
  return {
    mediaType,
    status: row?.status ?? 'UNKNOWN',
    pagesCount: row?.page_count ?? 0,
    comment: row?.comment ?? '',
    mediaProfile: mediaProfileOf(mediaType),
    // Fixed-layout detection needs archive/EPUB inspection, which the analysis
    // job (M6) owns; until it runs, treat the book as reflowable-agnostic.
    epubDivinaCompatible: false,
    epubIsKepub: mediaType === 'application/kepub+zip',
  }
}

export function toBookMetadataDto(row: BookMetadataRow, extras: BookExtras): BookMetadataDto {
  return {
    title: row.title,
    titleLock: row.title_lock === 1,
    summary: row.summary,
    summaryLock: row.summary_lock === 1,
    number: row.number,
    numberLock: row.number_lock === 1,
    numberSort: row.number_sort,
    numberSortLock: row.number_sort_lock === 1,
    releaseDate: row.release_date,
    releaseDateLock: row.release_date_lock === 1,
    authors: extras.authors,
    authorsLock: row.authors_lock === 1,
    tags: extras.tags,
    tagsLock: row.tags_lock === 1,
    isbn: row.isbn,
    isbnLock: row.isbn_lock === 1,
    links: extras.links,
    linksLock: row.links_lock === 1,
    created: row.created_date,
    lastModified: row.last_modified_date,
  }
}

export function toReadProgressDto(row: ReadProgressRow | undefined): ReadProgressDto | undefined {
  if (!row) return undefined
  return {
    page: row.page,
    completed: row.completed === 1,
    deviceId: row.device_id,
    deviceName: row.device_name,
    readDate: row.read_date,
    created: row.created_date,
    lastModified: row.last_modified_date,
  }
}

/** Human-readable file size, matching Apache Commons' `byteCountToDisplaySize`. */
export function humanSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  if (bytes < 1024) return `${bytes} bytes`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`
}

export function toBookDto(
  row: BookRow,
  seriesTitle: string,
  metadata: BookMetadataDto,
  media: MediaDto,
  progress: ReadProgressDto | undefined,
): BookDto {
  const dto: BookDto = {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle,
    libraryId: row.library_id,
    name: row.name,
    url: row.url,
    number: row.number,
    oneshot: row.oneshot === 1,
    deleted: row.deleted_date !== null,
    created: row.created_date,
    lastModified: row.last_modified_date,
    fileLastModified: row.file_last_modified,
    fileHash: row.file_hash ?? '',
    size: humanSize(row.file_size),
    sizeBytes: row.file_size,
    media,
    metadata,
  }
  if (progress) dto.readProgress = progress
  return dto
}
