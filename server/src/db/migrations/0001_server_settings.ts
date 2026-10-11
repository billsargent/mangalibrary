import type { Migration } from '../migrate.js'

export const migration0001ServerSettings: Migration = {
  id: '0001_server_settings',
  up: async (db) => {
    await db.schema
      .createTable('server_settings')
      .ifNotExists()
      .addColumn('key', 'text', (col) => col.primaryKey())
      .addColumn('value', 'text', (col) => col.notNull())
      .execute()
  },
}
