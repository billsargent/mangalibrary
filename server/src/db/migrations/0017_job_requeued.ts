import type { Migration } from '../migrate.js'

/**
 * A job remembers being asked for again while it was running.
 *
 * The queue holds one row per piece of work, so asking for work that is already
 * queued changes nothing. Asking for work that is already *running* is different:
 * the run in progress started before the request and may not have seen what
 * prompted it - a scan that began before a file was copied in - and its row is
 * removed when it finishes. Without a mark the request would vanish with it.
 */
export const migration0017JobRequeued: Migration = {
  id: '0017_job_requeued',
  up: async (db) => {
    await db.schema
      .alterTable('jobs')
      .addColumn('requeued', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
}
