import { sql } from 'kysely'

import type { Migration } from '../migrate.js'

/**
 * Indexes that make taking the next job cost the same however long the queue is.
 *
 * The worker asks for the most important job nobody has, oldest first, whose group
 * has nothing running. Without an index in that order the database read and sorted
 * the whole queue for every job: with the 440,000 jobs a first scan of 200,000 books
 * leaves, that was 190 ms a job, and a book was analysed about once a second. With
 * these two it is a tenth of a millisecond.
 *
 * Both are partial - one holds only the jobs waiting, the other only the few
 * running - so neither costs much to keep.
 */
export const migration0022JobQueueIndexes: Migration = {
  id: '0022_job_queue_indexes',
  up: async (db) => {
    await sql`
      create index if not exists idx__jobs__waiting
      on jobs (priority desc, last_modified_date, id)
      where owner is null
    `.execute(db)
    await sql`
      create index if not exists idx__jobs__running_group
      on jobs (group_id)
      where owner is not null and group_id is not null
    `.execute(db)
  },
}
