import type { Migration } from '../migrate.js'

export const migration0007ProgressOrganisation: Migration = {
  id: '0007_progress_organisation',
  up: async (db) => {
    await db.schema
      .createTable('read_progress')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('page', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('read_date', 'text')
      .addColumn('device_id', 'text')
      .addColumn('device_name', 'text')
      .addColumn('locator', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__read_progress', ['user_id', 'book_id'])
      .execute()

    await db.schema
      .createIndex('idx__read_progress__last_modified_date')
      .ifNotExists()
      .on('read_progress')
      .columns(['last_modified_date'])
      .execute()

    await db.schema
      .createTable('read_progress_series')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('read_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('in_progress_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('most_recent_read_date', 'text')
      .addColumn('most_recent_book_id', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__read_progress_series', ['user_id', 'series_id'])
      .execute()

    await db.schema
      .createIndex('idx__read_progress_series__most_recent_read_date')
      .ifNotExists()
      .on('read_progress_series')
      .columns(['most_recent_read_date'])
      .execute()

    await db.schema
      .createTable('collections')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('ordered', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('series_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__collections__name').ifNotExists().on('collections').columns(['name']).execute()

    await db.schema
      .createTable('collection_series')
      .ifNotExists()
      .addColumn('collection_id', 'text', (col) => col.notNull().references('collections.id').onDelete('cascade'))
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('number', 'integer', (col) => col.notNull().defaultTo(0))
      .addPrimaryKeyConstraint('pk__collection_series', ['collection_id', 'series_id'])
      .execute()

    await db.schema
      .createIndex('idx__collection_series__series_id')
      .ifNotExists()
      .on('collection_series')
      .columns(['series_id'])
      .execute()

    await db.schema
      .createTable('readlists')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('ordered', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('book_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__readlists__name').ifNotExists().on('readlists').columns(['name']).execute()

    await db.schema
      .createTable('readlist_book')
      .ifNotExists()
      .addColumn('readlist_id', 'text', (col) => col.notNull().references('readlists.id').onDelete('cascade'))
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('number', 'integer', (col) => col.notNull().defaultTo(0))
      .addPrimaryKeyConstraint('pk__readlist_book', ['readlist_id', 'book_id'])
      .execute()

    await db.schema
      .createIndex('idx__readlist_book__book_id')
      .ifNotExists()
      .on('readlist_book')
      .columns(['book_id'])
      .execute()

    await db.schema
      .createTable('readlist_request')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('readlist_id', 'text', (col) => col.notNull().references('readlists.id').onDelete('cascade'))
      .addColumn('name', 'text')
      .addColumn('series_id', 'text')
      .addColumn('books', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__readlist_request__readlist_id')
      .ifNotExists()
      .on('readlist_request')
      .columns(['readlist_id'])
      .execute()
  },
}
