import type { Migration } from '../migrate.js'

export const migration0005Media: Migration = {
  id: '0005_media',
  up: async (db) => {
    await db.schema
      .createTable('media')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.primaryKey().references('books.id').onDelete('cascade'))
      .addColumn('media_type', 'text')
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('comment', 'text')
      .addColumn('page_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__media__status').ifNotExists().on('media').columns(['status']).execute()

    await db.schema
      .createTable('media_page')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('number', 'integer', (col) => col.notNull())
      .addColumn('file_name', 'text', (col) => col.notNull())
      .addColumn('media_type', 'text', (col) => col.notNull())
      .addColumn('width', 'integer')
      .addColumn('height', 'integer')
      .addColumn('file_size', 'integer')
      .addPrimaryKeyConstraint('pk__media_page', ['book_id', 'number'])
      .execute()

    await db.schema
      .createTable('media_file')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('file_name', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__media_file', ['book_id', 'file_name'])
      .execute()

    await db.schema
      .createTable('media_container')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.primaryKey().references('books.id').onDelete('cascade'))
      .addColumn('entries', 'text', (col) => col.notNull().defaultTo('[]'))
      .execute()

    await db.schema
      .createTable('epub_toc')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.primaryKey().references('books.id').onDelete('cascade'))
      .addColumn('toc', 'text', (col) => col.notNull().defaultTo('[]'))
      .execute()

    await db.schema
      .createTable('epub_positions')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.primaryKey().references('books.id').onDelete('cascade'))
      .addColumn('positions', 'text', (col) => col.notNull().defaultTo('[]'))
      .execute()
  },
}
