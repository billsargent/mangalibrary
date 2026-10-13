import { sql } from 'kysely'

import type { Migration } from '../migrate.js'

/**
 * Indexes for listing a large library, and the statistics the database plans with.
 *
 * Measured on 200,000 books in 20,000 series. Each change answers something seen:
 *
 * - `idx__books__deleted_date` held one value for every book - none is deleted - and
 *   the planner, knowing no better, chose it to find the books of twenty series by
 *   reading all 200,000. It is replaced by an index of the deleted ones only, which
 *   is what the trash needs and which cannot be mistaken for a way to find the rest.
 * - Counting the books of a library read every row; `(library_id, deleted_date)`
 *   answers it from the index alone.
 * - The orders a library is browsed in - by series title, by number, by date added,
 *   by release date - each get an index of the sort column and the key that breaks
 *   ties, so a page can be read off the index in order. The single-column indexes
 *   these replace are dropped.
 *
 * And the database is told what is in its tables. Without that it guesses, and its
 * guesses are what made opening one series read the whole library (128 ms; 2 ms
 * once it knew). `refreshStatistics` keeps this up to date afterwards.
 */
export const migration0023ListingIndexes: Migration = {
  id: '0023_listing_indexes',
  up: async (db) => {
    const statements = [
      sql`drop index if exists idx__books__deleted_date`,
      sql`create index if not exists idx__books__trash on books (library_id) where deleted_date is not null`,
      sql`create index if not exists idx__books__library_live on books (library_id, deleted_date)`,

      sql`drop index if exists idx__books__created_date`,
      sql`create index if not exists idx__books__created_date on books (created_date, id)`,

      sql`drop index if exists idx__book_metadata__number_sort`,
      sql`create index if not exists idx__book_metadata__number_sort on book_metadata (number_sort, book_id)`,
      sql`drop index if exists idx__book_metadata__release_date`,
      sql`create index if not exists idx__book_metadata__release_date on book_metadata (release_date, book_id)`,

      sql`create index if not exists idx__series_metadata__title_sort on series_metadata (title_sort, series_id)`,

      sql`pragma analysis_limit = 1000`,
      sql`analyze`,
    ]
    for (const statement of statements) await statement.execute(db)
  },
}
