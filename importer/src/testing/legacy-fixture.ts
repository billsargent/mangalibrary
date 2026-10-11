import BetterSqlite3 from 'better-sqlite3'

/**
 * Builds a legacy Komga database covering the tables the importer maps.
 *
 * The real legacy schema drifted across 80+ migrations, so this fixture
 * deliberately exposes a representative subset of columns; the importer must
 * tolerate missing columns.
 */
export function createLegacyFixture(file: string): void {
  const db = new BetterSqlite3(file)

  db.exec(`
    create table LIBRARY (
      ID text primary key, NAME text not null, ROOT text not null,
      IMPORT_COMICINFO_BOOK integer not null default 1,
      IMPORT_COMICINFO_SERIES integer not null default 1,
      SCAN_INTERVAL text not null default 'EVERY_6H',
      HASH_FILES integer not null default 1,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table LIBRARY_EXCLUSIONS (LIBRARY_ID text not null, EXCLUSION text not null);
    create table USER (
      ID text primary key, EMAIL text not null, PASSWORD text not null,
      SHARED_ALL_LIBRARIES integer not null default 1, AGE_RESTRICTION integer null,
      AGE_RESTRICTION_ALLOW_ONLY integer null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table USER_ROLE (USER_ID text not null, ROLE text not null);
    create table USER_LIBRARY_SHARING (USER_ID text not null, LIBRARY_ID text not null);
    create table USER_SHARING (USER_ID text not null, ALLOW integer not null, LABEL text not null);
    create table SERIES (
      ID text primary key, LIBRARY_ID text not null, NAME text not null, URL text not null,
      FILE_LAST_MODIFIED datetime not null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table SERIES_METADATA (
      SERIES_ID text primary key, STATUS text not null, STATUS_LOCK integer not null default 0,
      TITLE text not null, TITLE_LOCK integer not null default 0, TITLE_SORT text not null,
      PUBLISHER text not null default '', LANGUAGE text not null default '', SUMMARY text not null default '',
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table SERIES_METADATA_AUTHOR (SERIES_ID text not null, NAME text not null, ROLE text not null);
    create table SERIES_METADATA_TAG (SERIES_ID text not null, TAG text not null);
    create table SERIES_METADATA_GENRE (SERIES_ID text not null, GENRE text not null);
    create table SERIES_METADATA_LINK (SERIES_ID text not null, LABEL text not null, URL text not null);
    create table SERIES_METADATA_SHARING (SERIES_ID text not null, LABEL text not null);
    create table BOOK (
      ID text primary key, SERIES_ID text not null, LIBRARY_ID text not null, NAME text not null,
      URL text not null, FILE_LAST_MODIFIED datetime not null, FILE_SIZE integer not null default 0,
      NUMBER integer not null default 0,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table BOOK_METADATA (
      BOOK_ID text primary key, TITLE text not null, TITLE_LOCK integer not null default 0,
      NUMBER text not null default '', NUMBER_LOCK integer not null default 0,
      NUMBER_SORT real not null default 0, NUMBER_SORT_LOCK integer not null default 0,
      SUMMARY text not null default '', AUTHORS_LOCK integer not null default 0,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table BOOK_METADATA_AUTHOR (BOOK_ID text not null, NAME text not null, ROLE text not null);
    create table BOOK_METADATA_TAG (BOOK_ID text not null, TAG text not null);
    create table BOOK_METADATA_LINK (BOOK_ID text not null, LABEL text not null, URL text not null);
    create table MEDIA (
      BOOK_ID text primary key, MEDIA_TYPE text null, STATUS text not null,
      PAGE_COUNT integer not null default 0, COMMENT text null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table MEDIA_PAGE (
      BOOK_ID text not null, NUMBER integer not null, FILE_NAME text not null, MEDIA_TYPE text not null,
      WIDTH integer null, HEIGHT integer null, FILE_SIZE integer null
    );
    create table THUMBNAIL_BOOK (
      ID text primary key, BOOK_ID text not null, TYPE text not null, PAGE integer not null default 0,
      SELECTED integer not null default 1, MEDIA_TYPE text not null, WIDTH integer not null,
      HEIGHT integer not null, FILE_SIZE integer not null, THUMBNAIL blob not null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table THUMBNAIL_SERIES (
      ID text primary key, SERIES_ID text not null, TYPE text not null, PAGE integer not null default 0,
      SELECTED integer not null default 1, MEDIA_TYPE text not null, WIDTH integer not null,
      HEIGHT integer not null, FILE_SIZE integer not null, THUMBNAIL blob not null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table READ_PROGRESS (
      USER_ID text not null, BOOK_ID text not null, PAGE integer not null default 0,
      COMPLETED integer not null default 0, READ_DATE datetime null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table COLLECTION (
      ID text primary key, NAME text not null, ORDERED integer not null default 0,
      SERIES_COUNT integer not null default 0,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table COLLECTION_SERIES (COLLECTION_ID text not null, SERIES_ID text not null, NUMBER integer not null default 0);
    create table READLIST (
      ID text primary key, NAME text not null, SUMMARY text not null default '',
      ORDERED integer not null default 0,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table READLIST_BOOK (READLIST_ID text not null, BOOK_ID text not null, NUMBER integer not null default 0);
    create table SERVER_SETTINGS (KEY text primary key, VALUE text not null);
    create table CLIENT_SETTINGS_GLOBAL (KEY text primary key, VALUE text not null);
    create table CLIENT_SETTINGS_USER (USER_ID text not null, KEY text not null, VALUE text not null);
    create table PAGE_HASH (HASH text not null, BOOK_ID text not null, PAGE_NUMBER integer not null, FILE_SIZE integer not null, DELETE_COUNT integer not null default 0);
    create table PAGE_HASH_UNKNOWN (HASH text primary key, FILE_SIZE integer not null, DELETE_COUNT integer not null default 0, CREATED_DATE datetime not null default current_timestamp, LAST_MODIFIED_DATE datetime not null default current_timestamp);
    create table PAGE_HASH_MATCH (HASH text not null, BOOK_ID text not null, PAGE_NUMBER integer not null);
  `)

  const insert = (sql: string, rows: unknown[][]) => {
    const statement = db.prepare(sql)
    for (const row of rows) statement.run(...row)
  }

  insert('insert into LIBRARY (ID, NAME, ROOT) values (?, ?, ?)', [['L1', 'Library', '/library']])
  insert('insert into LIBRARY_EXCLUSIONS (LIBRARY_ID, EXCLUSION) values (?, ?)', [['L1', '#recycle']])
  insert(
    'insert into USER (ID, EMAIL, PASSWORD, SHARED_ALL_LIBRARIES, AGE_RESTRICTION, AGE_RESTRICTION_ALLOW_ONLY) values (?, ?, ?, ?, ?, ?)',
    [
      ['U1', 'admin@example.com', '$2a$10$abcdefghijklmnopqrstuv', 1, null, null],
      ['U2', 'kid@example.com', '$2a$10$zyxwvutsrqponmlkjihgfe', 0, 12, 1],
    ],
  )
  insert('insert into USER_ROLE (USER_ID, ROLE) values (?, ?)', [
    ['U1', 'ADMIN'],
    ['U1', 'FILE_DOWNLOAD'],
    ['U2', 'PAGE_STREAMING'],
  ])
  insert('insert into USER_LIBRARY_SHARING (USER_ID, LIBRARY_ID) values (?, ?)', [['U2', 'L1']])
  insert('insert into USER_SHARING (USER_ID, ALLOW, LABEL) values (?, ?, ?)', [
    ['U2', 0, 'mature'],
    ['U2', 1, 'kids'],
  ])
  insert('insert into SERIES (ID, LIBRARY_ID, NAME, URL, FILE_LAST_MODIFIED) values (?, ?, ?, ?, ?)', [
    ['S1', 'L1', 'Akira', 'akira', '2024-01-01 10:00:00'],
  ])
  insert(
    'insert into SERIES_METADATA (SERIES_ID, STATUS, TITLE, TITLE_LOCK, TITLE_SORT, PUBLISHER, LANGUAGE, SUMMARY) values (?, ?, ?, ?, ?, ?, ?, ?)',
    [['S1', 'ENDED', 'Akira', 1, 'Akira', 'Kodansha', 'en', 'A cyberpunk classic.']],
  )
  insert('insert into SERIES_METADATA_AUTHOR (SERIES_ID, NAME, ROLE) values (?, ?, ?)', [['S1', 'Katsuhiro Otomo', 'writer']])
  insert('insert into SERIES_METADATA_TAG (SERIES_ID, TAG) values (?, ?)', [['S1', 'cyberpunk']])
  insert('insert into SERIES_METADATA_GENRE (SERIES_ID, GENRE) values (?, ?)', [['S1', 'Science Fiction']])
  insert('insert into SERIES_METADATA_LINK (SERIES_ID, LABEL, URL) values (?, ?, ?)', [['S1', 'Wikipedia', 'https://example.org/akira']])
  insert('insert into SERIES_METADATA_SHARING (SERIES_ID, LABEL) values (?, ?)', [['S1', 'mature']])
  insert(
    'insert into BOOK (ID, SERIES_ID, LIBRARY_ID, NAME, URL, FILE_LAST_MODIFIED, FILE_SIZE, NUMBER) values (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      ['B1', 'S1', 'L1', 'Volume 1', 'v1.cbz', '2024-01-01 10:00:00', 1024, 1],
      ['B2', 'S1', 'L1', 'Volume 2', 'v2.cbz', '2024-01-02 10:00:00', 2048, 2],
    ],
  )
  insert('insert into BOOK_METADATA (BOOK_ID, TITLE, NUMBER, NUMBER_SORT) values (?, ?, ?, ?)', [
    ['B1', 'Akira Volume One', '1', 1],
    ['B2', 'Akira Volume Two', '2', 2],
  ])
  insert('insert into BOOK_METADATA_AUTHOR (BOOK_ID, NAME, ROLE) values (?, ?, ?)', [['B1', 'Katsuhiro Otomo', 'writer']])
  insert('insert into BOOK_METADATA_TAG (BOOK_ID, TAG) values (?, ?)', [['B1', 'cyberpunk']])
  insert('insert into BOOK_METADATA_LINK (BOOK_ID, LABEL, URL) values (?, ?, ?)', [['B1', 'Wikipedia', 'https://example.org/akira-v1']])
  insert('insert into MEDIA (BOOK_ID, MEDIA_TYPE, STATUS, PAGE_COUNT) values (?, ?, ?, ?)', [
    ['B1', 'application/zip', 'READY', 1],
    ['B2', 'application/zip', 'READY', 1],
  ])
  insert('insert into MEDIA_PAGE (BOOK_ID, NUMBER, FILE_NAME, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE) values (?, ?, ?, ?, ?, ?, ?)', [
    ['B1', 1, '001.jpg', 'image/jpeg', 800, 1200, 512],
    ['B2', 1, '001.jpg', 'image/jpeg', 800, 1200, 512],
  ])
  insert(
    'insert into THUMBNAIL_BOOK (ID, BOOK_ID, TYPE, PAGE, SELECTED, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE, THUMBNAIL) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [['T1', 'B1', 'GENERATED', 1, 1, 'image/jpeg', 4, 4, 11, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]],
  )
  insert(
    'insert into THUMBNAIL_SERIES (ID, SERIES_ID, TYPE, PAGE, SELECTED, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE, THUMBNAIL) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [['T2', 'S1', 'GENERATED', 1, 1, 'image/jpeg', 4, 4, 11, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]],
  )
  insert('insert into READ_PROGRESS (USER_ID, BOOK_ID, PAGE, COMPLETED, READ_DATE) values (?, ?, ?, ?, ?)', [
    ['U1', 'B1', 42, 0, '2024-02-01 12:00:00'],
  ])
  insert('insert into COLLECTION (ID, NAME, ORDERED, SERIES_COUNT) values (?, ?, ?, ?)', [['C1', 'Favourites', 1, 1]])
  insert('insert into COLLECTION_SERIES (COLLECTION_ID, SERIES_ID, NUMBER) values (?, ?, ?)', [['C1', 'S1', 0]])
  insert('insert into READLIST (ID, NAME, SUMMARY, ORDERED) values (?, ?, ?, ?)', [['R1', 'To read', 'Later', 1]])
  insert('insert into READLIST_BOOK (READLIST_ID, BOOK_ID, NUMBER) values (?, ?, ?)', [['R1', 'B2', 0]])
  insert('insert into SERVER_SETTINGS (KEY, VALUE) values (?, ?)', [
    ['REMEMBER_ME_KEY', 'abc123'],
    ['DELETE_EMPTY_COLLECTIONS', 'true'],
  ])
  insert('insert into CLIENT_SETTINGS_GLOBAL (KEY, VALUE) values (?, ?)', [['WEBUI_SERIES_GROUPS', 'alpha']])
  insert('insert into CLIENT_SETTINGS_USER (USER_ID, KEY, VALUE) values (?, ?, ?)', [['U1', 'WEBUI_POSTER_STRETCH', 'true']])
  insert('insert into PAGE_HASH (HASH, BOOK_ID, PAGE_NUMBER, FILE_SIZE) values (?, ?, ?, ?)', [['h1', 'B1', 1, 512]])
  insert('insert into PAGE_HASH_UNKNOWN (HASH, FILE_SIZE) values (?, ?)', [['h2', 999]])
  insert('insert into PAGE_HASH_MATCH (HASH, BOOK_ID, PAGE_NUMBER) values (?, ?, ?)', [['h2', 'B2', 1]])

  db.close()
}
