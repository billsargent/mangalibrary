import type { Migration } from '../migrate.js'

/**
 * Metadata locks for list-valued fields.
 *
 * Komga records a per-field lock for every editable metadata property, and PATCH
 * refuses to overwrite a locked one. The scalar locks already exist as columns;
 * the locks for the list-valued properties (tags, genres, links, alternate
 * titles, sharing labels and the aggregated book count) were missing, which made
 * those fields impossible to protect. Add them so the lock set is complete.
 */
export const migration0011MetadataLocks: Migration = {
  id: '0011_metadata_locks',
  up: async (db) => {
    for (const column of [
      'total_book_count_lock',
      'sharing_labels_lock',
      'tags_lock',
      'genres_lock',
      'links_lock',
      'alternate_titles_lock',
    ]) {
      await db.schema
        .alterTable('series_metadata')
        .addColumn(column, 'integer', (col) => col.notNull().defaultTo(0))
        .execute()
    }

    await db.schema
      .alterTable('book_metadata')
      .addColumn('links_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
}
