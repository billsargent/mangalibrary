import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'

/** How long the record of a sign-in is kept, which is what the reference keeps: a month. */
const KEPT_FOR_DAYS = 30

/**
 * Remove the sign-ins recorded more than a month ago, and say how many.
 *
 * Every sign-in, and every request signed with a password or a key, adds a row.
 * A server left running adds them for ever, and nobody reads last year's.
 */
export async function removeOldAuthenticationActivity(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  const olderThan = new Date(now.getTime() - KEPT_FOR_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.deleteFrom('authentication_activity').where('date_time', '<', olderThan).executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}
