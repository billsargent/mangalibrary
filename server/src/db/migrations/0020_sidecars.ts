import type { Migration } from '../migrate.js'

/**
 * The files beside a book or in a series' folder that say something about it, and
 * when each was last changed.
 *
 * A cover put next to a book, or a `series.json` edited in place, changes nothing
 * a scan otherwise looks at: the book is the same file and the folder's own date
 * may not move. Remembering each of these files' dates is how a scan notices, as
 * the reference's `sidecar` table does.
 */
export const migration0020Sidecars: Migration = {
  id: '0020_sidecars',
  up: async (db) => {
    await db.schema
      .createTable('sidecars')
      .addColumn('url', 'text', (col) => col.notNull())
      .addColumn('library_id', 'text', (col) => col.notNull().references('libraries.id').onDelete('cascade'))
      // The book's file or the series' folder the file speaks for.
      .addColumn('parent_url', 'text', (col) => col.notNull())
      .addColumn('source', 'text', (col) => col.notNull())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('last_modified', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__sidecars', ['library_id', 'url'])
      .execute()
  },
}
