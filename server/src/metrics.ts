/**
 * The numbers behind the metrics page, under the names the reference gives them.
 *
 * The reference publishes these through its metrics registry and a web interface
 * reads them one at a time from `/actuator/metrics/{name}`, narrowing to one
 * library or one task type with `?tag=key:value`. The same names, statistics and
 * units are kept here so a chart drawn from either server agrees.
 *
 * What is counted comes from two places. The contents of the libraries are read
 * from the database when asked, so they are always what is there now. What the
 * worker has done is counted in memory as it happens, so it starts from nothing
 * each time the server starts - which is what the reference's registry does too.
 */

import { sql, type Kysely } from 'kysely'

import type { DB } from './db/schema.js'

export interface Measurement {
  statistic: 'COUNT' | 'TOTAL_TIME' | 'MAX' | 'VALUE'
  value: number
}

export interface Metric {
  name: string
  description: string
  baseUnit?: string
  measurements: Measurement[]
  availableTags: { tag: string; values: string[] }[]
}

export interface MetricTag {
  key: string
  value: string
}

interface TaskTiming {
  count: number
  totalMs: number
  maxMs: number
}

const taskTimings = new Map<string, TaskTiming>()

/** Count a job the worker ran, and how long it took. A job that failed ran too. */
export function recordTask(type: string, ms: number): void {
  const timing = taskTimings.get(type) ?? { count: 0, totalMs: 0, maxMs: 0 }
  timing.count += 1
  timing.totalMs += ms
  timing.maxMs = Math.max(timing.maxMs, ms)
  taskTimings.set(type, timing)
}

/** Forget what was counted, which is what a restart does and what a test needs. */
export function resetTaskMetrics(): void {
  taskTimings.clear()
}

const TASKS = 'komga.tasks.execution'

/** A count kept per library, and how to read it. */
const PER_LIBRARY: Record<
  string,
  { description: string; baseUnit?: string; read: (db: Kysely<DB>) => Promise<Map<string, number>> }
> = {
  'komga.series': {
    description: 'Number of series, by library',
    read: async (db) =>
      grouped(
        await db
          .selectFrom('series')
          .select(['library_id as library', sql<number>`count(*)`.as('value')])
          .where('deleted_date', 'is', null)
          .groupBy('library_id')
          .execute(),
      ),
  },
  'komga.books': {
    description: 'Number of books, by library',
    read: async (db) =>
      grouped(
        await db
          .selectFrom('books')
          .select(['library_id as library', sql<number>`count(*)`.as('value')])
          .where('deleted_date', 'is', null)
          .groupBy('library_id')
          .execute(),
      ),
  },
  'komga.books.filesize': {
    description: 'Total size of the book files, by library',
    baseUnit: 'bytes',
    read: async (db) =>
      grouped(
        await db
          .selectFrom('books')
          .select(['library_id as library', sql<number>`coalesce(sum(file_size), 0)`.as('value')])
          .where('deleted_date', 'is', null)
          .groupBy('library_id')
          .execute(),
      ),
  },
  'komga.sidecars': {
    description: 'Number of cover files found beside books and series, by library',
    read: async (db) => {
      const books = await db
        .selectFrom('thumbnails')
        .innerJoin('books', 'books.id', 'thumbnails.owner_id')
        .select(['books.library_id as library', sql<number>`count(*)`.as('value')])
        .where('thumbnails.owner_type', '=', 'BOOK')
        .where('thumbnails.type', '=', 'SIDECAR')
        .where('books.deleted_date', 'is', null)
        .groupBy('books.library_id')
        .execute()
      const series = await db
        .selectFrom('thumbnails')
        .innerJoin('series', 'series.id', 'thumbnails.owner_id')
        .select(['series.library_id as library', sql<number>`count(*)`.as('value')])
        .where('thumbnails.owner_type', '=', 'SERIES')
        .where('thumbnails.type', '=', 'SIDECAR')
        .where('series.deleted_date', 'is', null)
        .groupBy('series.library_id')
        .execute()
      return grouped([...books, ...series])
    },
  },
}

/** A single count with nothing to narrow it by. */
const TOTALS: Record<string, { description: string; read: (db: Kysely<DB>) => Promise<number> }> = {
  'komga.collections': {
    description: 'Number of collections',
    read: async (db) =>
      countOf(
        await db
          .selectFrom('collections')
          .select(sql<number>`count(*)`.as('value'))
          .executeTakeFirst(),
      ),
  },
  'komga.readlists': {
    description: 'Number of read lists',
    read: async (db) =>
      countOf(
        await db
          .selectFrom('readlists')
          .select(sql<number>`count(*)`.as('value'))
          .executeTakeFirst(),
      ),
  },
}

function grouped(rows: readonly { library: string; value: number }[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.library, (totals.get(row.library) ?? 0) + Number(row.value))
  return totals
}

function countOf(row: { value: number } | undefined): number {
  return Number(row?.value ?? 0)
}

/** Every metric there is to ask for. */
export function metricNames(): string[] {
  return [...Object.keys(PER_LIBRARY), ...Object.keys(TOTALS), TASKS].sort()
}

/**
 * Read `key:value` tags out of a query string, where one tag arrives as a string
 * and several as a list. Returns `null` for one that is not a pair.
 */
export function parseTags(raw: unknown): MetricTag[] | null {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const tags: MetricTag[] = []
  for (const value of values) {
    if (typeof value !== 'string') return null
    const split = value.indexOf(':')
    if (split <= 0 || split === value.length - 1) return null
    tags.push({ key: value.slice(0, split), value: value.slice(split + 1) })
  }
  return tags
}

/**
 * One metric, narrowed by the tags given.
 *
 * `null` is "there is no such thing": a name that is not a metric, a tag the
 * metric does not have, or a value of that tag nothing was counted under - which
 * is where the reference answers 404 as well.
 */
export async function readMetric(
  db: Kysely<DB>,
  name: string,
  tags: readonly MetricTag[] = [],
): Promise<Metric | null> {
  if (name === TASKS) return taskMetric(tags)

  const total = TOTALS[name]
  if (total) {
    if (tags.length > 0) return null
    return {
      name,
      description: total.description,
      measurements: [{ statistic: 'VALUE', value: await total.read(db) }],
      availableTags: [],
    }
  }

  const perLibrary = PER_LIBRARY[name]
  if (!perLibrary) return null
  if (tags.some((tag) => tag.key !== 'library')) return null

  // Every library is a value of the tag, including one that holds nothing yet:
  // an empty library is a zero on the chart, not a gap in it.
  const libraries = (await db.selectFrom('libraries').select('id').orderBy('name').execute()).map((row) => row.id)
  const counts = await perLibrary.read(db)
  const base = {
    name,
    description: perLibrary.description,
    ...(perLibrary.baseUnit ? { baseUnit: perLibrary.baseUnit } : {}),
  }

  const [tag] = tags
  if (tag) {
    if (tags.some((other) => other.value !== tag.value) || !libraries.includes(tag.value)) return null
    return { ...base, measurements: [{ statistic: 'VALUE', value: counts.get(tag.value) ?? 0 }], availableTags: [] }
  }

  const sum = libraries.reduce((running, id) => running + (counts.get(id) ?? 0), 0)
  return {
    ...base,
    measurements: [{ statistic: 'VALUE', value: sum }],
    availableTags: libraries.length > 0 ? [{ tag: 'library', values: libraries }] : [],
  }
}

function taskMetric(tags: readonly MetricTag[]): Metric | null {
  if (tags.some((tag) => tag.key !== 'type')) return null
  const base = { name: TASKS, description: 'Jobs the worker has run since the server started', baseUnit: 'seconds' }

  const [tag] = tags
  let timings: TaskTiming[]
  if (tag) {
    const one = taskTimings.get(tag.value)
    if (!one || tags.some((other) => other.value !== tag.value)) return null
    timings = [one]
  } else {
    timings = [...taskTimings.values()]
  }

  return {
    ...base,
    measurements: [
      { statistic: 'COUNT', value: timings.reduce((sum, timing) => sum + timing.count, 0) },
      { statistic: 'TOTAL_TIME', value: timings.reduce((sum, timing) => sum + timing.totalMs, 0) / 1000 },
      { statistic: 'MAX', value: timings.reduce((max, timing) => Math.max(max, timing.maxMs), 0) / 1000 },
    ],
    availableTags: tag || taskTimings.size === 0 ? [] : [{ tag: 'type', values: [...taskTimings.keys()].sort() }],
  }
}
