import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DB } from './db/schema.js'

/** Priority levels, matching Komga's task priorities. */
export const JOB_PRIORITY = { HIGHEST: 8, HIGH: 6, DEFAULT: 4, LOW: 2, LOWEST: 0 } as const

export interface EnqueueOptions {
  type: string
  /** Deduplication key: enqueuing the same key twice refreshes the existing job. */
  uniqueKey: string
  priority?: number
  groupId?: string | null
  payload?: unknown
}

/**
 * Record a background job.
 *
 * The worker that executes jobs lands with the domain-services step (M6); until
 * then this keeps the API contract intact — endpoints accept and queue work.
 */
export async function enqueueJob(db: Kysely<DB>, options: EnqueueOptions): Promise<void> {
  const now = new Date().toISOString()
  const payload = JSON.stringify(options.payload ?? {})
  await db
    .insertInto('jobs')
    .values({
      id: randomBytes(13).toString('hex'),
      type: options.type,
      priority: options.priority ?? JOB_PRIORITY.DEFAULT,
      group_id: options.groupId ?? null,
      unique_key: options.uniqueKey,
      payload,
      owner: null,
      attempts: 0,
      created_date: now,
      last_modified_date: now,
    })
    .onConflict((oc) => oc.column('unique_key').doUpdateSet({ last_modified_date: now, payload }))
    .execute()
}
