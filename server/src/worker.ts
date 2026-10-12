/**
 * The worker: what turns the queue into work actually being done.
 *
 * A tick looks for jobs it may run, up to the pool size the server is set to, and
 * runs each in its own asynchronous task while keeping the count. A tick also
 * looks after the schedule: a library with a scan interval is scanned on that
 * interval, which is what keeps a watched folder watched.
 *
 * The queue is polled rather than pushed to: work that is queued while nothing is
 * running is picked up by the next tick, half a second later at the worst. A job
 * that finishes does not wait for it - its place is taken straight away, so a
 * queue of short jobs runs as fast as the jobs do.
 */

import type { Kysely } from 'kysely'

import type { DB } from './db/schema.js'
import { EventBus } from './events.js'
import { handleJob, type JobContext, type JobLogger } from './handlers.js'
import { JOB_PRIORITY, deleteJob, disownJobs, enqueueJob, takeNextJob, type JobRecord } from './jobs.js'
import { SETTING_KEYS, getIntSetting } from './settings.js'

/** How often the queue and the schedule are looked at. */
const TICK_MS = 500

/** The scan intervals a library can ask for, as the API spells them. */
const SCAN_INTERVALS: Record<string, number> = {
  HOURLY: 60 * 60 * 1000,
  EVERY_6H: 6 * 60 * 60 * 1000,
  EVERY_12H: 12 * 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
}

/** The unique key a library scan is queued under, wherever it is queued from. */
export function scanKey(libraryId: string): string {
  return `SCANLIBRARY_${libraryId}`
}

export interface JobWorker {
  /** Stop taking work, and wait for what is running to finish. */
  stop(): Promise<void>
}

export interface WorkerOptions {
  db: Kysely<DB>
  log: JobLogger
  /** Where content changes are announced. A worker without one announces nothing. */
  events?: EventBus
  /** Turn the scan schedule off, which the tests do. */
  schedule?: boolean
}

/**
 * Start the worker, and release whatever a previous run left claimed.
 *
 * A job is claimed while it runs, so a process that stopped without finishing left
 * its claim behind; releasing those is what lets a restart carry on rather than
 * leaving work stranded forever.
 */
export async function startJobWorker(options: WorkerOptions): Promise<JobWorker> {
  const { db, log } = options
  const context: JobContext = { db, log, events: options.events ?? new EventBus() }
  const owner = `worker-${process.pid}`

  const disowned = await disownJobs(db)
  if (disowned > 0) log.info({ count: disowned }, 'released jobs left claimed by a previous run')

  let stopped = false
  let running = 0

  const poolSize = async (): Promise<number> => {
    const configured = await getIntSetting(db, SETTING_KEYS.taskPoolSize, 1)
    // The reference treats a pool size below one as one, because a server that
    // never runs anything is not what anybody means by setting it to zero.
    return Math.max(1, configured)
  }

  const runJob = async (job: JobRecord): Promise<void> => {
    const started = Date.now()
    try {
      await handleJob(context, job)
      log.debug({ type: job.type, job: job.id, ms: Date.now() - started }, 'job finished')
    } catch (error) {
      // The job is dropped either way: the reference does the same, and the
      // schedule or the next scan is what asks for the work again.
      log.error({ type: job.type, job: job.id, err: String(error) }, 'job failed')
    } finally {
      await deleteJob(db, job.id).catch((error: unknown) => {
        log.error({ job: job.id, err: String(error) }, 'could not remove a finished job')
      })
    }
  }

  // One fill at a time: two looking at the count together would each think there
  // was room for the same job more. One that is asked for meanwhile runs after.
  let filling = false
  let fillAgain = false

  const fill = async (): Promise<void> => {
    if (filling) {
      fillAgain = true
      return
    }
    filling = true
    try {
      do {
        fillAgain = false
        const size = await poolSize()
        while (!stopped && running < size) {
          const job = await takeNextJob(db, owner)
          if (job === null) break

          running += 1
          void runJob(job).finally(() => {
            running -= 1
            // The place a job leaves is taken at once. Waiting for the next tick
            // would cost half a second for every job, and a library is a great
            // many short jobs.
            fill().catch((error: unknown) => log.error({ err: String(error) }, 'could not look for work'))
          })
        }
      } while (fillAgain && !stopped)
    } finally {
      filling = false
    }
  }

  // The schedule lives in memory: a library is scanned on its interval from the
  // moment the process started watching it, as a fixed-rate task does.
  const schedule = new Map<string, { interval: string; nextScanAt: number }>()

  const scanDue = async (): Promise<void> => {
    const now = Date.now()
    const libraries = await db.selectFrom('libraries').select(['id', 'scan_interval']).execute()
    const seen = new Set<string>()

    for (const library of libraries) {
      seen.add(library.id)
      const interval = SCAN_INTERVALS[library.scan_interval]
      const entry = schedule.get(library.id)

      if (interval === undefined) {
        // Disabled, or an interval this server does not know: no schedule at all.
        schedule.delete(library.id)
        continue
      }

      if (entry === undefined || entry.interval !== library.scan_interval) {
        schedule.set(library.id, { interval: library.scan_interval, nextScanAt: now + interval })
        continue
      }

      if (entry.nextScanAt > now) continue
      entry.nextScanAt = now + interval
      await enqueueJob(db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey(library.id),
        priority: JOB_PRIORITY.HIGH,
        payload: { libraryId: library.id, scanDeep: false },
      })
    }

    for (const id of schedule.keys()) if (!seen.has(id)) schedule.delete(id)
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      await fill()
      if (options.schedule !== false) await scanDue()
    } catch (error) {
      // A database that is briefly unreadable - a shutdown, a lock - must not stop
      // the worker for good.
      log.error({ err: String(error) }, 'could not look for work')
    }
  }

  // A library that asks to be scanned on startup is scanned once, now.
  const startup = await db.selectFrom('libraries').select(['id', 'scan_on_startup']).execute()
  for (const library of startup) {
    if (library.scan_on_startup !== 1) continue
    log.info({ libraryId: library.id }, 'scanning a library on startup')
    await enqueueJob(db, {
      type: 'ScanLibrary',
      uniqueKey: scanKey(library.id),
      priority: JOB_PRIORITY.HIGH,
      payload: { libraryId: library.id, scanDeep: false },
    })
  }

  const timer = setInterval(() => void tick(), TICK_MS)
  // A timer must not be the reason a process stays alive at shutdown.
  timer.unref?.()
  void tick()

  return {
    stop: async (): Promise<void> => {
      stopped = true
      clearInterval(timer)
      // Give what is running a moment to finish, so a scan is not cut in half.
      for (let attempt = 0; attempt < 100 && running > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Anything still running has its claim released, so the next start picks it up.
      const released = await disownJobs(db)
      if (released > 0) log.info({ count: released }, 'released jobs that were still running')
    },
  }
}
