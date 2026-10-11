import type { Generated } from 'kysely'

/**
 * Kysely database type for the MangaLibrary schema.
 *
 * Conventions:
 * - ids are TSID strings (see `src/tsid.ts`);
 * - dates are ISO-8601 strings set in application code (no DB defaults);
 * - booleans are 0/1 integers;
 * - list-valued columns hold JSON text.
 */
export interface DB {
  schema_migrations: SchemaMigrationsTable
  server_settings: ServerSettingsTable

  // Identity
  users: UsersTable
  user_sharing: UserSharingTable
  user_library_sharing: UserLibrarySharingTable
  user_api_keys: UserApiKeysTable
  authentication_activity: AuthenticationActivityTable
  sessions: SessionsTable

  // Library
  libraries: LibrariesTable
  library_exclusions: LibraryExclusionsTable

  // Content
  series: SeriesTable
  series_metadata: SeriesMetadataTable
  series_metadata_author: SeriesMetadataAuthorTable
  series_metadata_tag: SeriesMetadataTagTable
  series_metadata_genre: SeriesMetadataGenreTable
  series_metadata_link: SeriesMetadataLinkTable
  series_metadata_alternate_title: SeriesMetadataAlternateTitleTable
  series_metadata_sharing: SeriesMetadataSharingTable
  books: BooksTable
  book_metadata: BookMetadataTable
  book_metadata_author: BookMetadataAuthorTable
  book_metadata_tag: BookMetadataTagTable
  book_metadata_link: BookMetadataLinkTable
  book_metadata_aggregation: BookMetadataAggregationTable
  book_metadata_aggregation_author: BookMetadataAggregationAuthorTable
  book_metadata_aggregation_tag: BookMetadataAggregationTagTable

  // Media
  media: MediaTable
  media_page: MediaPageTable
  media_file: MediaFileTable
  media_container: MediaContainerTable
  epub_toc: EpubTocTable
  epub_positions: EpubPositionsTable

  // Artwork
  thumbnails: ThumbnailsTable

  // Progress & organisation
  read_progress: ReadProgressTable
  read_progress_series: ReadProgressSeriesTable
  collections: CollectionsTable
  collection_series: CollectionSeriesTable
  readlists: ReadListsTable
  readlist_book: ReadListBookTable
  readlist_request: ReadListRequestTable

  // Maintenance
  page_hash: PageHashTable
  page_hash_match: PageHashMatchTable
  page_hash_unknown: PageHashUnknownTable
  historical_events: HistoricalEventsTable
  jobs: JobsTable
  client_settings_global: ClientSettingsGlobalTable
  client_settings_user: ClientSettingsUserTable
  sync_points: SyncPointsTable
  sync_point_book: SyncPointBookTable
  sync_point_readlist: SyncPointReadListTable
  announcements_read: AnnouncementsReadTable
}

export interface SchemaMigrationsTable {
  id: string
  applied_at: string
}

export interface ServerSettingsTable {
  key: string
  value: string
}

export interface UsersTable {
  id: string
  email: string
  password: string
  roles: Generated<string>
  shared_all_libraries: Generated<number>
  age_restriction: number | null
  age_restriction_allow_only: number | null
  created_date: string
  last_modified_date: string
}

export interface UserSharingTable {
  user_id: string
  /** 1 = allow-list, 0 = exclude-list. */
  allow: number
  label: string
}

export interface UserLibrarySharingTable {
  user_id: string
  library_id: string
}

export interface UserApiKeysTable {
  id: string
  user_id: string
  key: string
  comment: string
  created_date: string
  last_modified_date: string
}

export interface AuthenticationActivityTable {
  id: string
  user_id: string | null
  email: string | null
  user_agent: string | null
  ip: string | null
  success: number
  error: string | null
  date_time: string
}

export interface SessionsTable {
  id: string
  user_id: string | null
  data: string
  expires_at: number
  created_date: string
}

export interface LibrariesTable {
  id: string
  name: string
  root: string
  import_comic_info_book: Generated<number>
  import_comic_info_series: Generated<number>
  import_comic_info_collection: Generated<number>
  import_comic_info_read_list: Generated<number>
  import_comic_info_series_append_volume: Generated<number>
  import_epub_book: Generated<number>
  import_epub_series: Generated<number>
  import_mylar_series: Generated<number>
  import_local_artwork: Generated<number>
  import_barcode_isbn: Generated<number>
  scan_force_modified_time: Generated<number>
  scan_on_startup: Generated<number>
  scan_interval: Generated<string>
  scan_cbx: Generated<number>
  scan_pdf: Generated<number>
  scan_epub: Generated<number>
  scan_directory_exclusions: Generated<string>
  repair_extensions: Generated<number>
  convert_to_cbz: Generated<number>
  empty_trash_after_scan: Generated<number>
  series_cover: Generated<string>
  hash_files: Generated<number>
  hash_pages: Generated<number>
  hash_koreader: Generated<number>
  analyze_dimensions: Generated<number>
  oneshots_directory: string | null
  unavailable_date: string | null
  created_date: string
  last_modified_date: string
}

export interface LibraryExclusionsTable {
  library_id: string
  exclusion: string
}

export interface SeriesTable {
  id: string
  library_id: string
  name: string
  url: string
  file_last_modified: string
  book_count: Generated<number>
  oneshot: Generated<number>
  deleted_date: string | null
  created_date: string
  last_modified_date: string
}

export interface SeriesMetadataTable {
  series_id: string
  status: Generated<string>
  status_lock: Generated<number>
  title: string
  title_lock: Generated<number>
  title_sort: string
  title_sort_lock: Generated<number>
  publisher: Generated<string>
  publisher_lock: Generated<number>
  language: Generated<string>
  language_lock: Generated<number>
  age_rating: number | null
  age_rating_lock: Generated<number>
  reading_direction: string | null
  reading_direction_lock: Generated<number>
  summary: Generated<string>
  summary_lock: Generated<number>
  total_book_count: number | null
  created_date: string
  last_modified_date: string
}

export interface SeriesMetadataAuthorTable {
  series_id: string
  name: string
  role: string
}

export interface SeriesMetadataTagTable {
  series_id: string
  tag: string
}

export interface SeriesMetadataGenreTable {
  series_id: string
  genre: string
}

export interface SeriesMetadataLinkTable {
  series_id: string
  label: string
  url: string
}

export interface SeriesMetadataAlternateTitleTable {
  series_id: string
  title: string
  label: string
}

export interface SeriesMetadataSharingTable {
  series_id: string
  label: string
}

export interface BooksTable {
  id: string
  series_id: string
  library_id: string
  name: string
  url: string
  file_last_modified: string
  file_size: Generated<number>
  file_hash: string | null
  file_hash_koreader: string | null
  number: Generated<number>
  oneshot: Generated<number>
  deleted_date: string | null
  created_date: string
  last_modified_date: string
}

export interface BookMetadataTable {
  book_id: string
  title: string
  title_lock: Generated<number>
  number: Generated<string>
  number_lock: Generated<number>
  number_sort: Generated<number>
  number_sort_lock: Generated<number>
  release_date: string | null
  release_date_lock: Generated<number>
  summary: Generated<string>
  summary_lock: Generated<number>
  publisher: Generated<string>
  publisher_lock: Generated<number>
  isbn: Generated<string>
  isbn_lock: Generated<number>
  age_rating: number | null
  age_rating_lock: Generated<number>
  reading_direction: string | null
  reading_direction_lock: Generated<number>
  authors_lock: Generated<number>
  tags_lock: Generated<number>
  created_date: string
  last_modified_date: string
}

export interface BookMetadataAuthorTable {
  book_id: string
  name: string
  role: string
}

export interface BookMetadataTagTable {
  book_id: string
  tag: string
}

export interface BookMetadataLinkTable {
  book_id: string
  label: string
  url: string
}

export interface BookMetadataAggregationTable {
  series_id: string
  title: string
  title_sort: string
  summary: Generated<string>
  publisher: Generated<string>
  language: Generated<string>
  age_rating: number | null
  status: string | null
  reading_direction: string | null
  release_date: string | null
  created_date: string
  last_modified_date: string
}

export interface BookMetadataAggregationAuthorTable {
  series_id: string
  name: string
  role: string
}

export interface BookMetadataAggregationTagTable {
  series_id: string
  tag: string
}

export interface MediaTable {
  book_id: string
  media_type: string | null
  status: string
  comment: string | null
  page_count: Generated<number>
  created_date: string
  last_modified_date: string
}

export interface MediaPageTable {
  book_id: string
  number: number
  file_name: string
  media_type: string
  width: number | null
  height: number | null
  file_size: number | null
}

export interface MediaFileTable {
  book_id: string
  file_name: string
}

export interface MediaContainerTable {
  book_id: string
  entries: Generated<string>
}

export interface EpubTocTable {
  book_id: string
  toc: Generated<string>
}

export interface EpubPositionsTable {
  book_id: string
  positions: Generated<string>
}

export type ThumbnailOwnerType = 'BOOK' | 'SERIES' | 'COLLECTION' | 'READLIST'
export type ThumbnailType = 'GENERATED' | 'USER' | 'SIDECAR' | 'URL'

export interface ThumbnailsTable {
  id: string
  owner_type: ThumbnailOwnerType
  owner_id: string
  type: ThumbnailType
  page: Generated<number>
  selected: Generated<number>
  media_type: string
  width: number
  height: number
  file_size: number
  thumbnail: Buffer
  created_date: string
  last_modified_date: string
}

export interface ReadProgressTable {
  user_id: string
  book_id: string
  page: Generated<number>
  completed: Generated<number>
  read_date: string | null
  device_id: string | null
  device_name: string | null
  locator: string | null
  created_date: string
  last_modified_date: string
}

export interface ReadProgressSeriesTable {
  user_id: string
  series_id: string
  read_count: Generated<number>
  in_progress_count: Generated<number>
  most_recent_read_date: string | null
  most_recent_book_id: string | null
  created_date: string
  last_modified_date: string
}

export interface CollectionsTable {
  id: string
  name: string
  ordered: Generated<number>
  series_count: Generated<number>
  created_date: string
  last_modified_date: string
}

export interface CollectionSeriesTable {
  collection_id: string
  series_id: string
  number: Generated<number>
}

export interface ReadListsTable {
  id: string
  name: string
  summary: Generated<string>
  ordered: Generated<number>
  book_count: Generated<number>
  created_date: string
  last_modified_date: string
}

export interface ReadListBookTable {
  readlist_id: string
  book_id: string
  number: Generated<number>
}

export interface ReadListRequestTable {
  id: string
  readlist_id: string
  name: string | null
  series_id: string | null
  books: Generated<string>
  created_date: string
  last_modified_date: string
}

export interface PageHashTable {
  hash: string
  book_id: string
  page_number: number
  file_size: number
  delete_count: Generated<number>
}

export interface PageHashMatchTable {
  hash: string
  book_id: string
  page_number: number
}

export interface PageHashUnknownTable {
  hash: string
  file_size: number
  delete_count: Generated<number>
  created_date: string
  last_modified_date: string
}

export type HistoricalEventType =
  | 'BOOK_FILE_DELETED'
  | 'SERIES_FOLDER_DELETED'
  | 'BOOK_CONVERTED'
  | 'BOOK_IMPORTED'
  | 'DUPLICATE_PAGE_DELETED'

export interface HistoricalEventsTable {
  id: string
  type: HistoricalEventType
  book_id: string | null
  series_id: string | null
  properties: Generated<string>
  timestamp: string
}

export interface JobsTable {
  id: string
  type: string
  priority: number
  group_id: string | null
  unique_key: string
  payload: Generated<string>
  owner: string | null
  attempts: Generated<number>
  created_date: string
  last_modified_date: string
}

export interface ClientSettingsGlobalTable {
  key: string
  value: string
}

export interface ClientSettingsUserTable {
  user_id: string
  key: string
  value: string
}

export interface SyncPointsTable {
  id: string
  user_id: string
  api_key_id: string | null
  created_date: string
  last_modified_date: string
}

export interface SyncPointBookTable {
  sync_point_id: string
  book_id: string
  created_date: string
  last_modified_date: string
}

export interface SyncPointReadListTable {
  sync_point_id: string
  readlist_id: string
  created_date: string
  last_modified_date: string
}

export interface AnnouncementsReadTable {
  user_id: string
  announcement_id: string
  read_date: string
}

