import type { Migration } from '../migrate.js'

/**
 * Ordered migration registry.
 *
 * The domain schema (libraries, series, books, users, ...) is added under the
 * issues that implement those areas; this first migration establishes the
 * server-level settings store.
 */
export const migrations: Migration[] = [
  {
    id: '0001_server_settings',
    up: async (db) => {
      await db.schema
        .createTable('server_settings')
        .ifNotExists()
        .addColumn('key', 'text', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute()
    },
  },
]
