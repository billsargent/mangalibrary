import type { Migration } from '../migrate.js'

export const migration0008Maintenance: Migration = {
  id: '0008_maintenance',
  up: async (db) => {
    await db.schema
      .createTable('page_hash')
      .ifNotExists()
      .addColumn('hash', 'text', (col) => col.notNull())
      .addColumn('book_id', 'text', (col) => col.notNull().references('books.id').onDelete('cascade'))
      .addColumn('page_number', 'integer', (col) => col.notNull())
      .addColumn('file_size', 'integer', (col) => col.notNull())
      .addColumn('delete_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addPrimaryKeyConstraint('pk__page_hash', ['hash', 'book_id', 'page_number'])
      .execute()

    await db.schema.createIndex('idx__page_hash__book_id').ifNotExists().on('page_hash').columns(['book_id']).execute()

    await db.schema
      .createTable('page_hash_match')
      .ifNotExists()
      .addColumn('hash', 'text', (col) => col.notNull())
      .addColumn('book_id', 'text', (col) => col.notNull())
      .addColumn('page_number', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__page_hash_match', ['hash', 'book_id', 'page_number'])
      .execute()

    await db.schema
      .createTable('page_hash_unknown')
      .ifNotExists()
      .addColumn('hash', 'text', (col) => col.primaryKey())
      .addColumn('file_size', 'integer', (col) => col.notNull())
      .addColumn('delete_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    // History keeps its book/series references after deletion, so no foreign keys here.
    await db.schema
      .createTable('historical_events')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('book_id', 'text')
      .addColumn('series_id', 'text')
      .addColumn('properties', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('timestamp', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__historical_events__timestamp')
      .ifNotExists()
      .on('historical_events')
      .columns(['timestamp'])
      .execute()

    await db.schema
      .createTable('jobs')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('priority', 'integer', (col) => col.notNull())
      .addColumn('group_id', 'text')
      .addColumn('unique_key', 'text', (col) => col.notNull().unique())
      .addColumn('payload', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('owner', 'text')
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__jobs__pending')
      .ifNotExists()
      .on('jobs')
      .columns(['priority', 'last_modified_date'])
      .execute()

    await db.schema.createIndex('idx__jobs__group_id').ifNotExists().on('jobs').columns(['group_id']).execute()

    await db.schema
      .createTable('client_settings_global')
      .ifNotExists()
      .addColumn('key', 'text', (col) => col.primaryKey())
      .addColumn('value', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createTable('client_settings_user')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('key', 'text', (col) => col.notNull())
      .addColumn('value', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__client_settings_user', ['user_id', 'key'])
      .execute()

    await db.schema
      .createTable('sync_points')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('api_key_id', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__sync_points__user_id')
      .ifNotExists()
      .on('sync_points')
      .columns(['user_id'])
      .execute()

    await db.schema
      .createTable('sync_point_book')
      .ifNotExists()
      .addColumn('sync_point_id', 'text', (col) => col.notNull().references('sync_points.id').onDelete('cascade'))
      .addColumn('book_id', 'text', (col) => col.notNull())
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__sync_point_book', ['sync_point_id', 'book_id'])
      .execute()

    await db.schema
      .createTable('sync_point_readlist')
      .ifNotExists()
      .addColumn('sync_point_id', 'text', (col) => col.notNull().references('sync_points.id').onDelete('cascade'))
      .addColumn('readlist_id', 'text', (col) => col.notNull())
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__sync_point_readlist', ['sync_point_id', 'readlist_id'])
      .execute()

    await db.schema
      .createTable('announcements_read')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('announcement_id', 'text', (col) => col.notNull())
      .addColumn('read_date', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__announcements_read', ['user_id', 'announcement_id'])
      .execute()
  },
}
