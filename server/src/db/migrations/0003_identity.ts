import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

export const migration0003Identity: Migration = {
  id: '0003_identity',
  up: async (db) => {
    await db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('email', 'text', (col) => col.notNull())
      .addColumn('password', 'text', (col) => col.notNull())
      .addColumn('roles', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('shared_all_libraries', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('age_restriction', 'integer')
      .addColumn('sharing_labels', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    // Email uniqueness is case-insensitive.
    await db.schema
      .createIndex('idx__users__email')
      .ifNotExists()
      .unique()
      .on('users')
      .expression(sql`lower(email)`)
      .execute()

    await db.schema
      .createTable('user_library_sharing')
      .ifNotExists()
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('library_id', 'text', (col) => col.notNull().references('libraries.id').onDelete('cascade'))
      .addPrimaryKeyConstraint('pk__user_library_sharing', ['user_id', 'library_id'])
      .execute()

    await db.schema
      .createTable('user_api_keys')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('key', 'text', (col) => col.notNull().unique())
      .addColumn('comment', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__user_api_keys__user_id')
      .ifNotExists()
      .on('user_api_keys')
      .columns(['user_id'])
      .execute()

    await db.schema
      .createTable('authentication_activity')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('email', 'text')
      .addColumn('user_agent', 'text')
      .addColumn('ip', 'text')
      .addColumn('success', 'integer', (col) => col.notNull())
      .addColumn('error', 'text')
      .addColumn('date_time', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('idx__authentication_activity__user_id')
      .ifNotExists()
      .on('authentication_activity')
      .columns(['user_id'])
      .execute()

    await db.schema
      .createTable('sessions')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.references('users.id').onDelete('cascade'))
      .addColumn('data', 'text', (col) => col.notNull())
      .addColumn('expires_at', 'integer', (col) => col.notNull())
      .addColumn('created_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema.createIndex('idx__sessions__expires_at').ifNotExists().on('sessions').columns(['expires_at']).execute()
    await db.schema.createIndex('idx__sessions__user_id').ifNotExists().on('sessions').columns(['user_id']).execute()
  },
}
