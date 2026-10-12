import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

/**
 * Reshape duplicate-page detection to the shape current Komga uses, and put a
 * page's hash where the page is.
 *
 * The three `page_hash*` tables this replaces were built from a shape Komga has not
 * had for years: a `page_hash` row naming one book and one page number, a separate
 * `page_hash_match` table, and an `page_hash_unknown` table of hashes nobody
 * recognised. Current Komga stores it the other way round, which is what makes the
 * API's own queries possible at all:
 *
 * - `media_page.file_hash` is where a page's hash lives, so a page carries its own
 *   identity and "which pages hold this hash" is one indexed lookup.
 * - `page_hash` is one row per hash somebody has judged - with the `action` the API
 *   is built around (`DELETE_AUTO`, `DELETE_MANUAL`, `IGNORE`), the size, how many
 *   times pages with it have been deleted, and when it was seen.
 * - `page_hash_thumbnail` is the image of a known duplicate, so the browser can show
 *   what it is about to remove.
 * - An *unknown* hash is not stored at all: it is a page whose hash is not in
 *   `page_hash`, which the API asks for by joining the two.
 *
 * Nothing else changed, so the old rows are copied across: a hash keeps its size and
 * its delete count. Old rows had no action - the column never existed here - and
 * `IGNORE` is the honest reading of "somebody marked this and we do not know why":
 * it says the duplicates are known, and removes nothing.
 */
export const migration0015PageHash: Migration = {
  id: '0015_page_hash',
  up: async (db) => {
    // Where a page's own hash lives.
    await db.schema
      .alterTable('media_page')
      .addColumn('file_hash', 'text', (col) => col.notNull().defaultTo(''))
      .execute()

    await db.schema
      .createIndex('idx__media_page__file_hash')
      .ifNotExists()
      .on('media_page')
      .columns(['file_hash'])
      .execute()

    // One row per hash somebody has judged.
    await db.schema
      .createTable('page_hash_new')
      .addColumn('hash', 'text', (col) => col.primaryKey())
      .addColumn('size', 'integer')
      .addColumn('action', 'text', (col) => col.notNull())
      .addColumn('delete_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await sql`
      insert into page_hash_new (hash, size, action, delete_count, created_date, last_modified_date)
      select hash, max(file_size), 'IGNORE', max(delete_count), current_timestamp, current_timestamp
      from page_hash
      group by hash
    `.execute(db)

    await db.schema.dropTable('page_hash').execute()
    await db.schema.alterTable('page_hash_new').renameTo('page_hash').execute()

    // The image of a known duplicate, which the API serves.
    await db.schema
      .createTable('page_hash_thumbnail')
      .addColumn('hash', 'text', (col) => col.primaryKey())
      .addColumn('thumbnail', 'blob', (col) => col.notNull())
      .execute()

    // Matches are pages carrying the hash, and unknown hashes are pages whose hash
    // nobody has judged: both are read from `media_page` now.
    await db.schema.dropTable('page_hash_match').execute()
    await db.schema.dropTable('page_hash_unknown').execute()
  },
}
