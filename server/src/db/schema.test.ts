import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase } from './index.js'
import { migrate } from './migrate.js'
import { migrations } from './migrations/index.js'

const EXPECTED_TABLES = [
  // identity
  'users',
  'user_sharing',
  'user_library_sharing',
  'user_api_keys',
  'authentication_activity',
  'sessions',
  // library
  'libraries',
  'library_exclusions',
  // content
  'series',
  'series_metadata',
  'series_metadata_author',
  'series_metadata_tag',
  'series_metadata_genre',
  'series_metadata_link',
  'series_metadata_alternate_title',
  'series_metadata_sharing',
  'books',
  'book_metadata',
  'book_metadata_author',
  'book_metadata_tag',
  'book_metadata_link',
  'book_metadata_aggregation',
  'book_metadata_aggregation_author',
  'book_metadata_aggregation_tag',
  // media
  'media',
  'media_page',
  'media_file',
  'media_container',
  'epub_toc',
  'epub_positions',
  // artwork
  'thumbnails',
  // progress & organisation
  'read_progress',
  'read_progress_series',
  'collections',
  'collection_series',
  'readlists',
  'readlist_book',
  'readlist_request',
  // maintenance
  'page_hash',
  'page_hash_match',
  'page_hash_unknown',
  'historical_events',
  'jobs',
  'server_settings',
  'client_settings_global',
  'client_settings_user',
  'sync_points',
  'sync_point_book',
  'sync_point_readlist',
  'announcements_read',
  // search
  'fts_books',
  'fts_series',
  'fts_collections',
  'fts_readlists',
  'fts_authors',
]

async function migratedDatabase() {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  return database
}

describe('schema', () => {
  it('creates every expected table', async () => {
    const database = await migratedDatabase()
    const result = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(database.db)
    const names = new Set(result.rows.map((row) => row.name))
    const missing = EXPECTED_TABLES.filter((table) => !names.has(table))
    expect(missing).toEqual([])
    await database.close()
  })

  it('creates the FTS5 synchronisation triggers', async () => {
    const database = await migratedDatabase()
    const result = await sql<{ name: string }>`
      select name from sqlite_master where type = 'trigger' and name like '%__a%'
    `.execute(database.db)
    const names = result.rows.map((row) => row.name)
    expect(names).toContain('book_metadata__ai')
    expect(names).toContain('book_metadata__au')
    expect(names).toContain('series_metadata__ai')
    expect(names).toContain('book_metadata_aggregation_author__ai')
    await database.close()
  })

  it('indexes metadata through the triggers and can search it', async () => {
    const database = await migratedDatabase()
    const now = new Date().toISOString()

    await database.db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'Library', root: '/library', created_date: now, last_modified_date: now })
      .execute()
    await database.db
      .insertInto('series')
      .values({
        id: 'S1',
        library_id: 'L1',
        name: 'Akira',
        url: 'akira',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await database.db
      .insertInto('books')
      .values({
        id: 'B1',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'v1.cbz',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await database.db
      .insertInto('book_metadata')
      .values({ book_id: 'B1', title: 'Akira Volume One', created_date: now, last_modified_date: now })
      .execute()

    const found = await sql<{
      book_id: string
    }>`select book_id from fts_books where fts_books match ${'akira'}`.execute(database.db)
    expect(found.rows.map((row) => row.book_id)).toContain('B1')

    await database.close()
  })

  it('enforces foreign keys and cascades deletes', async () => {
    const database = await migratedDatabase()
    const now = new Date().toISOString()

    await database.db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'Library', root: '/library', created_date: now, last_modified_date: now })
      .execute()
    await database.db
      .insertInto('series')
      .values({
        id: 'S1',
        library_id: 'L1',
        name: 'Series',
        url: 'series',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    await database.db.deleteFrom('libraries').where('id', '=', 'L1').execute()

    const remaining = await database.db.selectFrom('series').selectAll().execute()
    expect(remaining).toEqual([])

    await database.close()
  })
})
