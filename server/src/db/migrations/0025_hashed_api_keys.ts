import { createHash } from 'node:crypto'

import type { Migration } from '../migrate.js'

/**
 * API keys kept as the reference keeps them: the hex SHA-512 of each key, never the
 * key itself.
 *
 * A key was stored as it was given out, so anybody holding a copy of the database
 * held every key. From here a key is shown once, when it is made, and only its hash
 * is kept (`hashApiKey` in `auth/users.ts`). The keys already given out keep working:
 * each is replaced by its hash, which is what a request presenting it is now
 * compared with. A value that is already a hash - 128 hex characters - is left.
 */
export const migration0025HashedApiKeys: Migration = {
  id: '0025_hashed_api_keys',
  up: async (db) => {
    const rows = await db.selectFrom('user_api_keys').select(['id', 'key']).execute()
    for (const row of rows) {
      if (/^[0-9a-f]{128}$/.test(row.key)) continue
      const hash = createHash('sha512').update(row.key.trim(), 'utf8').digest('hex')
      await db.updateTable('user_api_keys').set({ key: hash }).where('id', '=', row.id).execute()
    }
  },
}
