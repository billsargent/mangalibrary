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
      HASH_FILES integer not null default 1, SCAN_STARTUP integer not null default 0,
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
      TAGS_LOCK integer not null default 0, GENRES_LOCK integer not null default 0,
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
      LINKS_LOCK integer not null default 0,
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
      WIDTH integer null, HEIGHT integer null, FILE_SIZE integer null, FILE_HASH text not null default ''
    );
    create table THUMBNAIL_BOOK (
      ID text primary key, BOOK_ID text not null, TYPE text not null, PAGE integer not null default 0,
      SELECTED integer not null default 1, MEDIA_TYPE text not null, WIDTH integer not null,
      HEIGHT integer not null, FILE_SIZE integer not null, THUMBNAIL blob null, URL text null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table THUMBNAIL_SERIES (
      ID text primary key, SERIES_ID text not null, TYPE text not null, PAGE integer not null default 0,
      SELECTED integer not null default 1, MEDIA_TYPE text not null, WIDTH integer not null,
      HEIGHT integer not null, FILE_SIZE integer not null, THUMBNAIL blob null, URL text null,
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
    create table PAGE_HASH (
      HASH text not null primary key, SIZE int8 null, ACTION text not null,
      DELETE_COUNT integer not null default 0,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table PAGE_HASH_THUMBNAIL (HASH text not null primary key, THUMBNAIL blob not null);
    create table BOOK_METADATA_AGGREGATION (
      SERIES_ID text primary key, RELEASE_DATE date null, SUMMARY text not null default '',
      SUMMARY_NUMBER text not null default '',
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table BOOK_METADATA_AGGREGATION_AUTHOR (SERIES_ID text not null, NAME text not null, ROLE text not null);
    create table BOOK_METADATA_AGGREGATION_TAG (SERIES_ID text not null, TAG text not null);
    create table READ_PROGRESS_SERIES (
      SERIES_ID text not null, USER_ID text not null, READ_COUNT integer not null,
      IN_PROGRESS_COUNT integer not null, MOST_RECENT_READ_DATE datetime null,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
    create table MEDIA_FILE (FILE_NAME text not null, BOOK_ID text not null, MEDIA_TYPE text null, SUB_TYPE text null, FILE_SIZE integer null);
    create table USER_API_KEY (
      ID text primary key, USER_ID text not null, API_KEY text not null, COMMENT text not null,
      CREATED_DATE datetime not null default current_timestamp,
      LAST_MODIFIED_DATE datetime not null default current_timestamp
    );
  `)

  const insert = (sql: string, rows: unknown[][]) => {
    const statement = db.prepare(sql)
    for (const row of rows) statement.run(...row)
  }

  // Komga keeps every location as a file: URL of its own machine, percent-encoded,
  // with one slash after the scheme and a trailing one on folders.
  insert('insert into LIBRARY (ID, NAME, ROOT, SCAN_STARTUP) values (?, ?, ?, ?)', [
    ['L1', 'Library', 'file:/library/', 1],
  ])
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
    ['S1', 'L1', 'Akira', 'file:/library/Akira/', '2024-01-01 10:00:00'],
  ])
  insert(
    'insert into SERIES_METADATA (SERIES_ID, STATUS, TITLE, TITLE_LOCK, TITLE_SORT, PUBLISHER, LANGUAGE, SUMMARY, TAGS_LOCK) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [['S1', 'ENDED', 'Akira', 1, 'Akira', 'Kodansha', 'en', 'A cyberpunk classic.', 1]],
  )
  insert('insert into SERIES_METADATA_AUTHOR (SERIES_ID, NAME, ROLE) values (?, ?, ?)', [
    ['S1', 'Katsuhiro Otomo', 'writer'],
  ])
  insert('insert into SERIES_METADATA_TAG (SERIES_ID, TAG) values (?, ?)', [['S1', 'cyberpunk']])
  insert('insert into SERIES_METADATA_GENRE (SERIES_ID, GENRE) values (?, ?)', [['S1', 'Science Fiction']])
  insert('insert into SERIES_METADATA_LINK (SERIES_ID, LABEL, URL) values (?, ?, ?)', [
    ['S1', 'Wikipedia', 'https://example.org/akira'],
  ])
  insert('insert into SERIES_METADATA_SHARING (SERIES_ID, LABEL) values (?, ?)', [['S1', 'mature']])
  insert(
    'insert into BOOK (ID, SERIES_ID, LIBRARY_ID, NAME, URL, FILE_LAST_MODIFIED, FILE_SIZE, NUMBER) values (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      ['B1', 'S1', 'L1', 'Volume 1', 'file:/library/Akira/Volume%201.cbz', '2024-01-01 10:00:00', 1024, 1],
      // Komga writes most dates with nanoseconds, in UTC.
      ['B2', 'S1', 'L1', 'Volume 2', 'file:/library/Akira/Volume%202.cbz', '2024-01-02 10:00:00.123456789', 2048, 2],
    ],
  )
  insert('insert into BOOK_METADATA (BOOK_ID, TITLE, NUMBER, NUMBER_SORT, LINKS_LOCK) values (?, ?, ?, ?, ?)', [
    ['B1', 'Akira Volume One', '1', 1, 1],
    ['B2', 'Akira Volume Two', '2', 2, 0],
  ])
  insert('insert into BOOK_METADATA_AUTHOR (BOOK_ID, NAME, ROLE) values (?, ?, ?)', [
    ['B1', 'Katsuhiro Otomo', 'writer'],
  ])
  insert('insert into BOOK_METADATA_TAG (BOOK_ID, TAG) values (?, ?)', [['B1', 'cyberpunk']])
  insert('insert into BOOK_METADATA_LINK (BOOK_ID, LABEL, URL) values (?, ?, ?)', [
    ['B1', 'Wikipedia', 'https://example.org/akira-v1'],
  ])
  insert('insert into MEDIA (BOOK_ID, MEDIA_TYPE, STATUS, PAGE_COUNT) values (?, ?, ?, ?)', [
    ['B1', 'application/zip', 'READY', 1],
    ['B2', 'application/zip', 'READY', 1],
  ])
  insert(
    'insert into MEDIA_PAGE (BOOK_ID, NUMBER, FILE_NAME, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE, FILE_HASH) values (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      ['B1', 1, '001.jpg', 'image/jpeg', 800, 1200, 512, 'hash-1'],
      ['B2', 1, '001.jpg', 'image/jpeg', 800, 1200, 512, 'hash-1'],
    ],
  )
  insert(
    'insert into THUMBNAIL_BOOK (ID, BOOK_ID, TYPE, PAGE, SELECTED, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE, THUMBNAIL, URL) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      ['T1', 'B1', 'GENERATED', 1, 1, 'image/jpeg', 4, 4, 11, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), null],
      // A cover found beside the book, which Komga stores as the file's URL.
      ['T3', 'B1', 'SIDECAR', 0, 0, 'image/png', 40, 60, 128, null, 'file:/library/Akira/Volume%201.png'],
    ],
  )
  insert(
    'insert into THUMBNAIL_SERIES (ID, SERIES_ID, TYPE, PAGE, SELECTED, MEDIA_TYPE, WIDTH, HEIGHT, FILE_SIZE, THUMBNAIL, URL) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [['T2', 'S1', 'GENERATED', 1, 1, 'image/jpeg', 4, 4, 11, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), null]],
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
  insert('insert into CLIENT_SETTINGS_USER (USER_ID, KEY, VALUE) values (?, ?, ?)', [
    ['U1', 'WEBUI_POSTER_STRETCH', 'true'],
  ])
  insert('insert into PAGE_HASH (HASH, SIZE, ACTION, DELETE_COUNT) values (?, ?, ?, ?)', [
    ['hash-1', 512, 'DELETE_AUTO', 2],
  ])
  insert('insert into PAGE_HASH_THUMBNAIL (HASH, THUMBNAIL) values (?, ?)', [
    ['hash-1', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ])

  insert(
    'insert into BOOK_METADATA_AGGREGATION (SERIES_ID, RELEASE_DATE, SUMMARY, SUMMARY_NUMBER) values (?, ?, ?, ?)',
    [['S1', '1982-12-20', 'Neo-Tokyo, 2019.', '1']],
  )
  insert('insert into BOOK_METADATA_AGGREGATION_AUTHOR (SERIES_ID, NAME, ROLE) values (?, ?, ?)', [
    ['S1', 'Katsuhiro Otomo', 'writer'],
  ])
  insert('insert into BOOK_METADATA_AGGREGATION_TAG (SERIES_ID, TAG) values (?, ?)', [['S1', 'cyberpunk']])
  insert(
    'insert into READ_PROGRESS_SERIES (SERIES_ID, USER_ID, READ_COUNT, IN_PROGRESS_COUNT, MOST_RECENT_READ_DATE) values (?, ?, ?, ?, ?)',
    [['S1', 'U1', 0, 1, '2024-02-01 12:00:00.5']],
  )
  insert('insert into MEDIA_FILE (FILE_NAME, BOOK_ID) values (?, ?)', [['ComicInfo.xml', 'B1']])
  insert('insert into USER_API_KEY (ID, USER_ID, API_KEY, COMMENT) values (?, ?, ?, ?)', [
    ['K1', 'U1', 'hashed', 'phone'],
  ])

  db.close()
}
