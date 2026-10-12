import type { AuthUser } from '../auth/types.js'

/** Spring Data `Page` envelope, as serialised by springdoc. */
export interface SpringPage<T> {
  content: T[]
  pageable: {
    sort: { empty: boolean; sorted: boolean; unsorted: boolean }
    offset: number
    pageNumber: number
    pageSize: number
    paged: boolean
    unpaged: boolean
  }
  totalElements: number
  totalPages: number
  size: number
  number: number
  sort: { empty: boolean; sorted: boolean; unsorted: boolean }
  first: boolean
  last: boolean
  numberOfElements: number
  empty: boolean
}

const EMPTY_SORT = { empty: true, sorted: false, unsorted: true }

export function springPage<T>(content: T[], page: number, size: number, total: number): SpringPage<T> {
  const totalPages = size > 0 ? Math.ceil(total / size) : 0
  return {
    content,
    pageable: {
      sort: EMPTY_SORT,
      offset: page * size,
      pageNumber: page,
      pageSize: size,
      paged: true,
      unpaged: false,
    },
    totalElements: total,
    totalPages,
    size,
    number: page,
    sort: EMPTY_SORT,
    first: page === 0,
    last: page >= totalPages - 1,
    numberOfElements: content.length,
    empty: content.length === 0,
  }
}

export interface LibraryDto {
  id: string
  name: string
  root: string
  importComicInfoBook: boolean
  importComicInfoSeries: boolean
  importComicInfoCollection: boolean
  importComicInfoReadList: boolean
  importComicInfoSeriesAppendVolume: boolean
  importEpubBook: boolean
  importEpubSeries: boolean
  importMylarSeries: boolean
  importLocalArtwork: boolean
  importBarcodeIsbn: boolean
  scanForceModifiedTime: boolean
  scanOnStartup: boolean
  scanInterval: string
  scanCbx: boolean
  scanPdf: boolean
  scanEpub: boolean
  scanDirectoryExclusions: string[]
  repairExtensions: boolean
  convertToCbz: boolean
  emptyTrashAfterScan: boolean
  seriesCover: string
  hashFiles: boolean
  hashPages: boolean
  hashKoreader: boolean
  analyzeDimensions: boolean
  oneshotsDirectory: string
  unavailable: boolean
}

export interface LibraryRow {
  id: string
  name: string
  root: string
  import_comic_info_book: number
  import_comic_info_series: number
  import_comic_info_collection: number
  import_comic_info_read_list: number
  import_comic_info_series_append_volume: number
  import_epub_book: number
  import_epub_series: number
  import_mylar_series: number
  import_local_artwork: number
  import_barcode_isbn: number
  scan_force_modified_time: number
  scan_on_startup: number
  scan_interval: string
  scan_cbx: number
  scan_pdf: number
  scan_epub: number
  scan_directory_exclusions: string
  repair_extensions: number
  convert_to_cbz: number
  empty_trash_after_scan: number
  series_cover: string
  hash_files: number
  hash_pages: number
  hash_koreader: number
  analyze_dimensions: number
  oneshots_directory: string | null
  unavailable_date: string | null
}

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function toLibraryDto(row: LibraryRow): LibraryDto {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    importComicInfoBook: row.import_comic_info_book === 1,
    importComicInfoSeries: row.import_comic_info_series === 1,
    importComicInfoCollection: row.import_comic_info_collection === 1,
    importComicInfoReadList: row.import_comic_info_read_list === 1,
    importComicInfoSeriesAppendVolume: row.import_comic_info_series_append_volume === 1,
    importEpubBook: row.import_epub_book === 1,
    importEpubSeries: row.import_epub_series === 1,
    importMylarSeries: row.import_mylar_series === 1,
    importLocalArtwork: row.import_local_artwork === 1,
    importBarcodeIsbn: row.import_barcode_isbn === 1,
    scanForceModifiedTime: row.scan_force_modified_time === 1,
    scanOnStartup: row.scan_on_startup === 1,
    scanInterval: row.scan_interval,
    scanCbx: row.scan_cbx === 1,
    scanPdf: row.scan_pdf === 1,
    scanEpub: row.scan_epub === 1,
    scanDirectoryExclusions: parseStringArray(row.scan_directory_exclusions),
    repairExtensions: row.repair_extensions === 1,
    convertToCbz: row.convert_to_cbz === 1,
    emptyTrashAfterScan: row.empty_trash_after_scan === 1,
    seriesCover: row.series_cover,
    hashFiles: row.hash_files === 1,
    hashPages: row.hash_pages === 1,
    hashKoreader: row.hash_koreader === 1,
    analyzeDimensions: row.analyze_dimensions === 1,
    oneshotsDirectory: row.oneshots_directory ?? '',
    unavailable: row.unavailable_date !== null,
  }
}

export interface UserDto {
  id: string
  email: string
  roles: string[]
  sharedAllLibraries: boolean
  sharedLibrariesIds: string[]
  labelsAllow: string[]
  labelsExclude: string[]
  ageRestriction?: { age: number; restriction: string }
}

/**
 * The role every user is reported with.
 *
 * `USER` is not a stored role and is not in the reference's role enum: the reference adds
 * it to every user's DTO, because it is the role that stands for "may use the server at
 * all" and every account has it. A client that reads it - the reference's own UI gates its
 * library pages on it - has nothing to read if the role is missing, so a user with every
 * real role would be told they may not browse, and sent looking for a page they are allowed
 * on: for ever.
 */
export const REPORTED_ROLE_USER = 'USER'

export function userRoles(roles: readonly string[]): string[] {
  const result = [...roles]
  if (!result.includes(REPORTED_ROLE_USER)) result.push(REPORTED_ROLE_USER)
  return result
}

export function toUserDto(
  user: AuthUser,
  librarySharing: { sharedAllLibraries: boolean; sharedLibrariesIds: string[] },
): UserDto {
  const dto: UserDto = {
    id: user.id,
    email: user.email,
    roles: userRoles(user.roles),
    sharedAllLibraries: librarySharing.sharedAllLibraries,
    sharedLibrariesIds: [...librarySharing.sharedLibrariesIds],
    labelsAllow: [...user.restrictions.labelsAllow],
    labelsExclude: [...user.restrictions.labelsExclude],
  }
  if (user.restrictions.ageRestriction) {
    dto.ageRestriction = {
      age: user.restrictions.ageRestriction.age,
      restriction: user.restrictions.ageRestriction.restriction,
    }
  }
  return dto
}
