import type { Migration } from '../migrate.js'

export const migration0004Content: Migration = {
  id: '0004_content',
  up: async (db) => {
    // ------------------------------------------------------------- series
    await db.schema
      .createTable('series')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('library_id', 'text', (col) => col.notNull().references('libraries.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('url', 'text', (col) => col.notNull())
      .addColumn('file_last_modified', 'text', (col) => col.notNull())
      .addColumn('book_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('oneshot', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('deleted_date', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__series__library_id').ifNotExists().on('series').columns(['library_id']).execute()
    await db.schema.createIndex('idx__series__name').ifNotExists().on('series').columns(['name']).execute()
    await db.schema
      .createIndex('idx__series__created_date')
      .ifNotExists()
      .on('series')
      .columns(['created_date'])
      .execute()
    await db.schema
      .createIndex('idx__series__last_modified_date')
      .ifNotExists()
      .on('series')
      .columns(['last_modified_date'])
      .execute()

    await db.schema
      .createTable('series_metadata')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.primaryKey().references('series.id').onDelete('cascade'))
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('ONGOING'))
      .addColumn('status_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('title_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('title_sort', 'text', (col) => col.notNull())
      .addColumn('title_sort_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('publisher', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('publisher_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('language', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('language_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('age_rating', 'integer')
      .addColumn('age_rating_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('reading_direction', 'text')
      .addColumn('reading_direction_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('summary', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('summary_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('total_book_count', 'integer')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__series_metadata__title')
      .ifNotExists()
      .on('series_metadata')
      .columns(['title'])
      .execute()

    await db.schema
      .createTable('series_metadata_author')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('role', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_author', ['series_id', 'name', 'role'])
      .execute()

    await db.schema
      .createTable('series_metadata_tag')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('tag', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_tag', ['series_id', 'tag'])
      .execute()

    await db.schema
      .createTable('series_metadata_genre')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('genre', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_genre', ['series_id', 'genre'])
      .execute()

    await db.schema
      .createTable('series_metadata_link')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('label', 'text', (col) => col.notNull())
      .addColumn('url', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_link', ['series_id', 'label', 'url'])
      .execute()

    await db.schema
      .createTable('series_metadata_alternate_title')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('label', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_alternate_title', ['series_id', 'title', 'label'])
      .execute()

    await db.schema
      .createTable('series_metadata_sharing')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('label', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__series_metadata_sharing', ['series_id', 'label'])
      .execute()

    // -------------------------------------------------------------- books
    await db.schema
      .createTable('books')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('library_id', 'text', (col) => col.notNull().references('libraries.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('url', 'text', (col) => col.notNull())
      .addColumn('file_last_modified', 'text', (col) => col.notNull())
      .addColumn('file_size', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('file_hash', 'text')
      .addColumn('file_hash_koreader', 'text')
      .addColumn('number', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('oneshot', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('deleted_date', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__books__series_id').ifNotExists().on('books').columns(['series_id']).execute()
    await db.schema.createIndex('idx__books__library_id').ifNotExists().on('books').columns(['library_id']).execute()
    await db.schema
      .createIndex('idx__books__created_date')
      .ifNotExists()
      .on('books')
      .columns(['created_date'])
      .execute()
    await db.schema.createIndex('idx__books__file_hash').ifNotExists().on('books').columns(['file_hash']).execute()
    await db.schema
      .createIndex('idx__books__file_hash_koreader')
      .ifNotExists()
      .on('books')
      .columns(['file_hash_koreader'])
      .execute()
    await db.schema
      .createIndex('idx__books__deleted_date')
      .ifNotExists()
      .on('books')
      .columns(['deleted_date'])
      .execute()

    await db.schema
      .createTable('book_metadata')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.primaryKey().references('books.id').onDelete('cascade'))
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('title_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('number', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('number_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('number_sort', 'real', (col) => col.notNull().defaultTo(0))
      .addColumn('number_sort_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('release_date', 'text')
      .addColumn('release_date_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('summary', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('summary_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('publisher', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('publisher_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('isbn', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('isbn_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('age_rating', 'integer')
      .addColumn('age_rating_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('reading_direction', 'text')
      .addColumn('reading_direction_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('authors_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('tags_lock', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__book_metadata__number_sort')
      .ifNotExists()
      .on('book_metadata')
      .columns(['number_sort'])
      .execute()
    await db.schema
      .createIndex('idx__book_metadata__title')
      .ifNotExists()
      .on('book_metadata')
      .columns(['title'])
      .execute()
    await db.schema
      .createIndex('idx__book_metadata__release_date')
      .ifNotExists()
      .on('book_metadata')
      .columns(['release_date'])
      .execute()

    await db.schema
      .createTable('book_metadata_author')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('role', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__book_metadata_author', ['book_id', 'name', 'role'])
      .execute()

    await db.schema
      .createTable('book_metadata_tag')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('tag', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__book_metadata_tag', ['book_id', 'tag'])
      .execute()

    await db.schema
      .createTable('book_metadata_link')
      .ifNotExists()
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('label', 'text', (col) => col.notNull())
      .addColumn('url', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__book_metadata_link', ['book_id', 'label', 'url'])
      .execute()

    // ------------------------------------------------------- aggregation
    await db.schema
      .createTable('book_metadata_aggregation')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.primaryKey().references('series.id').onDelete('cascade'))
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('title_sort', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('publisher', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('language', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('age_rating', 'integer')
      .addColumn('status', 'text')
      .addColumn('reading_direction', 'text')
      .addColumn('release_date', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createTable('book_metadata_aggregation_author')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('role', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__book_metadata_aggregation_author', ['series_id', 'name', 'role'])
      .execute()

    await db.schema
      .createTable('book_metadata_aggregation_tag')
      .ifNotExists()
      .addColumn('series_id', 'text', (col) => col.notNull().references('series.id').onDelete('cascade'))
      .addColumn('tag', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__book_metadata_aggregation_tag', ['series_id', 'tag'])
      .execute()
  },
}
