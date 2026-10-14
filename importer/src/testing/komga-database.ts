import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'

const SCHEMA = fileURLToPath(new URL('./komga-schema.sql', import.meta.url))

/**
 * A Komga database with Komga's own schema (`komga-schema.sql`, built from its
 * migrations), holding rows written the way Komga writes them: `file:` URLs with one
 * slash and escapes, local times with nanoseconds, booleans as 0 and 1, a gzipped
 * reading position, a hashed API key.
 *
 * Where `legacy-fixture.ts` is the importer's own idea of Komga, this is Komga's.
 */
export function createKomgaDatabase(file: string, extra: (db: BetterSqlite3.Database) => void = () => {}): void {
  const db = new BetterSqlite3(file)
  db.exec(readFileSync(SCHEMA, 'utf8'))

  const insert = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values)
  const at = '2025-08-23 11:25:49.473855279'

  insert(
    `insert into LIBRARY (ID, NAME, ROOT, SCAN_STARTUP, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
    'L1',
    'Manga',
    'file:/srv/manga/',
    1,
    at,
    at,
  )
  insert(
    `insert into "USER" (ID, EMAIL, PASSWORD, SHARED_ALL_LIBRARIES, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
    'U1',
    'reader@example.com',
    '$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
    1,
    at,
    at,
  )
  for (const role of ['ADMIN', 'FILE_DOWNLOAD', 'PAGE_STREAMING'])
    insert(`insert into USER_ROLE (USER_ID, ROLE) values (?, ?)`, 'U1', role)
  // A label both allowed and excluded, which Komga's key allows.
  insert(`insert into USER_SHARING (LABEL, ALLOW, USER_ID) values (?, ?, ?)`, 'mature', 1, 'U1')
  insert(`insert into USER_SHARING (LABEL, ALLOW, USER_ID) values (?, ?, ?)`, 'mature', 0, 'U1')
  insert(
    `insert into USER_API_KEY (ID, USER_ID, API_KEY, COMMENT, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
    'K1',
    'U1',
    'f'.repeat(128),
    'phone',
    at,
    at,
  )

  insert(
    `insert into SERIES (ID, NAME, URL, FILE_LAST_MODIFIED, LIBRARY_ID, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?, ?)`,
    'S1',
    'One Piece',
    'file:/srv/manga/One%20Piece/',
    at,
    'L1',
    at,
    at,
  )
  insert(
    `insert into SERIES_METADATA (SERIES_ID, STATUS, TITLE, TITLE_SORT, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
    'S1',
    'ONGOING',
    'One Piece',
    'One Piece',
    at,
    at,
  )
  insert(
    `insert into SERIES_METADATA_ALTERNATE_TITLE (SERIES_ID, LABEL, TITLE) values (?, ?, ?)`,
    'S1',
    'Japanese',
    'ワンピース',
  )
  insert(
    `insert into BOOK_METADATA_AGGREGATION (SERIES_ID, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?)`,
    'S1',
    at,
    at,
  )

  const books = [
    ['B1', 'One Piece v01', 'file:/srv/manga/One%20Piece/One%20Piece%20v01.cbz', 'application/zip'],
    ['B2', 'One Piece v02', 'file:/srv/manga/One%20Piece/One%20Piece%20v02.epub', 'application/epub+zip'],
  ] as const
  for (const [index, [id, name, url, mediaType]] of books.entries()) {
    insert(
      `insert into BOOK (ID, NAME, URL, NUMBER, FILE_LAST_MODIFIED, FILE_SIZE, LIBRARY_ID, SERIES_ID, CREATED_DATE, LAST_MODIFIED_DATE)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      url,
      index + 1,
      at,
      1000,
      'L1',
      'S1',
      at,
      at,
    )
    insert(
      `insert into BOOK_METADATA (BOOK_ID, NUMBER, NUMBER_SORT, TITLE, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
      id,
      String(index + 1),
      index + 1,
      name,
      at,
      at,
    )
    insert(
      `insert into MEDIA (BOOK_ID, STATUS, MEDIA_TYPE, PAGE_COUNT, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?)`,
      id,
      'READY',
      mediaType,
      1,
      at,
      at,
    )
    insert(
      `insert into MEDIA_PAGE (BOOK_ID, FILE_NAME, MEDIA_TYPE, NUMBER, WIDTH, HEIGHT, FILE_SIZE) values (?, ?, ?, ?, ?, ?, ?)`,
      id,
      '001.jpg',
      'image/jpeg',
      0,
      800,
      1200,
      512,
    )
  }
  insert(
    `insert into READ_PROGRESS (BOOK_ID, USER_ID, PAGE, COMPLETED, READ_DATE, CREATED_DATE, LAST_MODIFIED_DATE) values (?, ?, ?, ?, ?, ?, ?)`,
    'B1',
    'U1',
    1,
    1,
    at,
    at,
    at,
  )
  insert(
    `insert into CLIENT_SETTINGS_GLOBAL (KEY, VALUE, ALLOW_UNAUTHORIZED) values (?, ?, ?)`,
    'WEBUI_LOGIN_BANNER',
    'Hello',
    1,
  )

  extra(db)
  db.close()
}
