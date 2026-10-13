import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { DB } from './db/schema.js'
import { nextTsid } from './tsid.js'

/**
 * How many times a job is run before it is given up on.
 *
 * Most failures are of the moment - a drive that was asleep, a file still being
 * copied - and the second run succeeds. A job that fails every time is not going
 * to be fixed by a fourth.
 */
export const MAX_JOB_ATTEMPTS = 3

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
 *
 * Asked for while it is running, the job is marked to run once more when it
 * finishes: the run in progress may have started before whatever prompted the
 * request, and its row would otherwise be removed with the request in it.
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
    .onConflict((oc) =>
      oc.column('unique_key').doUpdateSet({
        last_modified_date: now,
        payload,
        requeued: sql<number>`case when owner is not null then 1 else requeued end`,
      }),
    )
    .execute()
}

/**
 * Record many jobs as one piece of work: all of them or none.
 *
 * A scan asks for a job per book. Queued one by one, a stop part-way leaves some
 * of a library asked for and the rest forgotten, and each is a write of its own;
 * together they are one, which is also far quicker for a large library.
 */
export async function enqueueJobs(db: Kysely<DB>, jobs: readonly EnqueueOptions[]): Promise<void> {
  if (jobs.length === 0) return
  await db.transaction().execute(async (trx) => {
    for (const job of jobs) await enqueueJob(trx, job)
  })
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

/**
 * Take a job that has been run off the queue - or, when it was asked for again
 * while it ran, put it back to run once more. Says which.
 */
export async function finishJob(db: Kysely<DB>, id: string): Promise<'DONE' | 'REQUEUED'> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('jobs').select('requeued').where('id', '=', id).executeTakeFirst()
    if (row?.requeued !== 1) {
      await trx.deleteFrom('jobs').where('id', '=', id).execute()
      return 'DONE'
    }
    await trx
      .updateTable('jobs')
      .set({ owner: null, requeued: 0, attempts: 0, last_modified_date: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    return 'REQUEUED'
  })
}

/**
 * Deal with a job whose run threw: back on the queue while it has attempts left,
 * and off it for good when it has none. Says which.
 *
 * A job given up on that was asked for again meanwhile still gets that run, as a
 * fresh job: the request was for the work, not for another failure.
 */
export async function failJob(db: Kysely<DB>, job: JobRecord): Promise<'RETRY' | 'GAVE_UP'> {
  if (job.attempts < MAX_JOB_ATTEMPTS) {
    await db
      .updateTable('jobs')
      .set({ owner: null, last_modified_date: new Date().toISOString() })
      .where('id', '=', job.id)
      .execute()
    return 'RETRY'
  }
  await finishJob(db, job.id)
  return 'GAVE_UP'
}

/**
 * Leave a trace of a job that was given up on, where an operator looks: the
 * history, beside what else the server did to the library.
 */
export async function recordJobFailure(db: Kysely<DB>, job: JobRecord, error: unknown): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>
  const id = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : null)
  await db
    .insertInto('historical_events')
    .values({
      id: nextTsid(),
      type: 'TaskFailed',
      book_id: id('bookId'),
      series_id: id('seriesId'),
      properties: JSON.stringify({
        task: job.type,
        reason: error instanceof Error ? error.message : String(error),
        attempts: String(job.attempts),
        ...(id('libraryId') === null ? {} : { library: id('libraryId') }),
      }),
      timestamp: new Date().toISOString(),
    })
    .execute()
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
