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

/** A queued job, as the worker takes it. */
export interface JobRecord {
  id: string
  type: string
  priority: number
  /** Jobs sharing a group never run at the same time, which keeps a series' books in order. */
  groupId: string | null
  uniqueKey: string
  payload: unknown
  /** How many times the job has been handed to a worker. */
  attempts: number
}

/**
 * Record a background job.
 *
 * A job is a row, so it survives a restart and so two requests for the same work
 * collapse into one: the queue is keyed by `uniqueKey`, and asking for the same
 * key twice replaces what was queued rather than piling it up.
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

/**
 * Take the next job a worker may run, and claim it.
 *
 * A job is available when nobody owns it and no running job shares its group, which
 * is how the reference keeps two books of one series from being analysed at the
 * same time. The most important job goes first, and among equals the one that has
 * waited longest - so a queue that is only ever added to still moves.
 *
 * Claiming is a transaction, so two workers cannot take the same job.
 */
export async function takeNextJob(db: Kysely<DB>, owner: string): Promise<JobRecord | null> {
  const now = new Date().toISOString()

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('jobs')
      .selectAll()
      .where('owner', 'is', null)
      .where((eb) =>
        eb.or([
          eb('group_id', 'is', null),
          eb(
            'group_id',
            'not in',
            eb.selectFrom('jobs').select('group_id').where('owner', 'is not', null).where('group_id', 'is not', null),
          ),
        ]),
      )
      .orderBy('priority', 'desc')
      .orderBy('last_modified_date')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst()
    if (row === undefined) return null

    const attempts = row.attempts + 1
    await trx.updateTable('jobs').set({ owner, attempts, last_modified_date: now }).where('id', '=', row.id).execute()

    let payload: unknown = {}
    try {
      payload = JSON.parse(row.payload)
    } catch {
      // A row with an unreadable payload is still a job; the handler will say so.
    }
    return {
      id: row.id,
      type: row.type,
      priority: row.priority,
      groupId: row.group_id,
      uniqueKey: row.unique_key,
      payload,
      attempts,
    }
  })
}

/** Drop a job that has been run, whether or not it worked. */
export async function deleteJob(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('jobs').where('id', '=', id).execute()
}

/**
 * Release every claimed job, and report how many were.
 *
 * A job is claimed by whoever is running it, and a process that stops without
 * finishing leaves its claim behind. Releasing them is what lets a restart pick up
 * work that was interrupted.
 */
export async function disownJobs(db: Kysely<DB>): Promise<number> {
  const result = await db.updateTable('jobs').set({ owner: null }).where('owner', 'is not', null).executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}
