import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

/**
 * Let a thumbnail be a file on disk rather than bytes in the table.
 *
 * The reference keeps an artwork file found beside a book - `Volume 1.jpg` next to
 * `Volume 1.cbz` - as a thumbnail row carrying the file's URL and no bytes, so that
 * a large cover is not copied into the database. `thumbnails.thumbnail` was
 * `NOT NULL`, and SQLite cannot relax that in place, so the table is rebuilt: the
 * rows are copied across, the old table is dropped and the new one takes its name,
 * and the indexes are made again.
 */
export const migration0014ThumbnailUrl: Migration = {
  id: '0014_thumbnail_url',
  up: async (db) => {
    await db.schema
      .createTable('thumbnails_new')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('owner_type', 'text', (col) => col.notNull())
      .addColumn('owner_id', 'text', (col) => col.notNull())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('page', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('selected', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('media_type', 'text', (col) => col.notNull())
      .addColumn('width', 'integer', (col) => col.notNull())
      .addColumn('height', 'integer', (col) => col.notNull())
      .addColumn('file_size', 'integer', (col) => col.notNull())
      .addColumn('thumbnail', 'blob')
      .addColumn('url', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await sql`
      insert into thumbnails_new (
        id, owner_type, owner_id, type, page, selected, media_type, width, height,
        file_size, thumbnail, url, created_date, last_modified_date
      )
      select
        id, owner_type, owner_id, type, page, selected, media_type, width, height,
        file_size, thumbnail, null, created_date, last_modified_date
      from thumbnails
    `.execute(db)

    await db.schema.dropTable('thumbnails').execute()
    await db.schema.alterTable('thumbnails_new').renameTo('thumbnails').execute()

    await db.schema
      .createIndex('idx__thumbnails__owner')
      .ifNotExists()
      .on('thumbnails')
      .columns(['owner_type', 'owner_id'])
      .execute()

    await db.schema
      .createIndex('idx__thumbnails__selected')
      .ifNotExists()
      .on('thumbnails')
      .columns(['owner_type', 'owner_id', 'selected'])
      .execute()
  },
}
