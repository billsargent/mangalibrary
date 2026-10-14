import { sql } from 'kysely'

import type { Migration } from '../migrate.js'

/**
 * Repairs to the schema found by reading it (#121), each small now and a data repair
 * later.
 *
 * - **Indexes for the keys that point at books, series and libraries** and had none
 *   leading on them: deleting a book read every row of `read_progress` to find its
 *   progress, a series every row of `read_progress_series`, a library every row of
 *   `user_library_sharing`.
 * - **One index too many on `thumbnails`**: `(owner_type, owner_id)` is the start of
 *   `(owner_type, owner_id, selected)`, which answers everything it did.
 * - **Covers whose owner is gone.** A cover belongs to a book, a series, a collection
 *   or a read list, and the table cannot say which with a foreign key, so deleting
 *   the owner left the cover. Triggers now take a cover with its owner, and the ones
 *   already left behind are removed.
 * - **Dates in the shape the rest of the database uses.** Migration 0015 stamped the
 *   page hashes it carried over with SQLite's \`current_timestamp\`
 *   (\`2026-10-14 10:00:00\`) where every other date is ISO 8601.
 */
export const migration0026SchemaRepairs: Migration = {
  id: '0026_schema_repairs',
  up: async (db) => {
    const statements = [
      sql`create index if not exists idx__read_progress__book_id on read_progress (book_id)`,
      sql`create index if not exists idx__read_progress_series__series_id on read_progress_series (series_id)`,
      sql`create index if not exists idx__user_library_sharing__library_id on user_library_sharing (library_id)`,

      sql`drop index if exists idx__thumbnails__owner`,

      sql`delete from thumbnails where owner_type = 'BOOK' and owner_id not in (select id from books)`,
      sql`delete from thumbnails where owner_type = 'SERIES' and owner_id not in (select id from series)`,
      sql`delete from thumbnails where owner_type = 'COLLECTION' and owner_id not in (select id from collections)`,
      sql`delete from thumbnails where owner_type = 'READLIST' and owner_id not in (select id from readlists)`,
      sql`create trigger if not exists thumbnails__book_deleted after delete on books begin
        delete from thumbnails where owner_type = 'BOOK' and owner_id = old.id; end`,
      sql`create trigger if not exists thumbnails__series_deleted after delete on series begin
        delete from thumbnails where owner_type = 'SERIES' and owner_id = old.id; end`,
      sql`create trigger if not exists thumbnails__collection_deleted after delete on collections begin
        delete from thumbnails where owner_type = 'COLLECTION' and owner_id = old.id; end`,
      sql`create trigger if not exists thumbnails__readlist_deleted after delete on readlists begin
        delete from thumbnails where owner_type = 'READLIST' and owner_id = old.id; end`,

      sql`update page_hash set created_date = replace(created_date, ' ', 'T') || '.000Z'
        where created_date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
      sql`update page_hash set last_modified_date = replace(last_modified_date, ' ', 'T') || '.000Z'
        where last_modified_date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
    ]
    for (const statement of statements) await statement.execute(db)
  },
}
