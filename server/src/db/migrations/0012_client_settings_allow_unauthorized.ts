import type { Migration } from '../migrate.js'

/**
 * Global client settings can be readable without authentication.
 *
 * The contract exposes an `allowUnauthorized` flag on every global client
 * setting: a client that has not signed in yet still receives the ones marked
 * this way, which is how a UI can be configured before a user exists. The table
 * only stored the value, so the flag had nowhere to live.
 */
export const migration0012ClientSettingsAllowUnauthorized: Migration = {
  id: '0012_client_settings_allow_unauthorized',
  up: async (db) => {
    await db.schema
      .alterTable('client_settings_global')
      .addColumn('allow_unauthorized', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
}
