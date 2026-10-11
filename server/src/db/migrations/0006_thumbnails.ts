import type { Migration } from '../migrate.js'

export const migration0006Thumbnails: Migration = {
  id: '0006_thumbnails',
  up: async (db) => {
    await db.schema
      .createTable('thumbnails')
      .ifNotExists()
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
      .addColumn('thumbnail', 'blob', (col) => col.notNull())
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    // Owner lookup (list all artwork for a book/series/collection/read list).
    await db.schema
      .createIndex('idx__thumbnails__owner')
      .ifNotExists()
      .on('thumbnails')
      .columns(['owner_type', 'owner_id'])
      .execute()

    // Partial index for the currently selected thumbnail of an owner.
    await db.schema
      .createIndex('idx__thumbnails__selected')
      .ifNotExists()
      .on('thumbnails')
      .columns(['owner_type', 'owner_id', 'selected'])
      .execute()
  },
}
