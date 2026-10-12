import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import type { JobLogger } from './handlers.js'
import { JOB_PRIORITY, deleteJob, disownJobs, enqueueJob, takeNextJob } from './jobs.js'
import { SETTING_KEYS, setSetting } from './settings.js'
import { writeZip } from './testing/zip.js'
import { startJobWorker, scanKey } from './worker.js'

/** A real page image, so the fixture is a book a poster can be made from. */
async function page(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

/** A logger that remembers what it was told. */
function logger(): JobLogger & { messages: { level: string; message: string; context: Record<string, unknown> }[] } {
  const messages: { level: string; message: string; context: Record<string, unknown> }[] = []
  const record =
    (level: string) =>
    (context: Record<string, unknown>, message: string): void => {
      messages.push({ level, message, context })
    }
  return { messages, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
}

/** Wait until something is true, or give up. */
async function until<T>(check: () => Promise<T | null | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The queue orders by when a job was last asked for, so a test must space its asks. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

/** A library holding one CBZ that carries a ComicInfo document. */
async function setupLibrary(): Promise<{ database: Database; libraryId: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-worker-'))
  mkdirSync(join(root, 'Akira'), { recursive: true })
  writeFileSync(
    join(root, 'Akira', 'Volume 1.cbz'),
    writeZip([
      { name: 'page1.jpg', data: await page() },
      {
        name: 'ComicInfo.xml',
        data: Buffer.from('<ComicInfo><Series>Akira</Series><Writer>Katsuhiro Otomo</Writer></ComicInfo>', 'utf8'),
      },
    ]),
  )

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now })
    .execute()

  return { database, libraryId: 'L1', root }
}

describe('the job queue', () => {
  it('hands out the most important job first, and the oldest before its equals', async () => {
    const { database } = await setupLibrary()
    await enqueueJob(database.db, { type: 'Low', uniqueKey: 'low', priority: JOB_PRIORITY.LOW })
    await settle()
    await enqueueJob(database.db, { type: 'High', uniqueKey: 'high', priority: JOB_PRIORITY.HIGHEST })
    await settle()
    await enqueueJob(database.db, { type: 'AlsoLow', uniqueKey: 'also-low', priority: JOB_PRIORITY.LOW })

    expect((await takeNextJob(database.db, 'w1'))?.type).toBe('High')
    expect((await takeNextJob(database.db, 'w2'))?.type).toBe('Low')
    expect((await takeNextJob(database.db, 'w3'))?.type).toBe('AlsoLow')
    expect(await takeNextJob(database.db, 'w4')).toBeNull()
  })

  it('does not hand out a job whose group is already running', async () => {
    const { database } = await setupLibrary()
    await enqueueJob(database.db, { type: 'One', uniqueKey: 'one', groupId: 'S1' })
    await settle()
    await enqueueJob(database.db, { type: 'Two', uniqueKey: 'two', groupId: 'S1' })
    await settle()
    await enqueueJob(database.db, { type: 'Other', uniqueKey: 'other', groupId: 'S2' })

    const first = await takeNextJob(database.db, 'w1')
    expect(first?.type).toBe('One')

    // The other series can go ahead while the first is busy.
    expect((await takeNextJob(database.db, 'w2'))?.type).toBe('Other')
    expect(await takeNextJob(database.db, 'w3')).toBeNull()

    await deleteJob(database.db, first!.id)
    expect((await takeNextJob(database.db, 'w4'))?.type).toBe('Two')
  })

  it('replaces a queued job of the same unique key rather than piling up', async () => {
    const { database } = await setupLibrary()
    await enqueueJob(database.db, { type: 'Scan', uniqueKey: 'same', payload: { first: true } })
    await enqueueJob(database.db, { type: 'Scan', uniqueKey: 'same', payload: { second: true } })

    const rows = await database.db.selectFrom('jobs').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect((await takeNextJob(database.db, 'w1'))?.payload).toEqual({ second: true })
  })

  it('releases every claim, which is what a restart needs', async () => {
    const { database } = await setupLibrary()
    await enqueueJob(database.db, { type: 'Scan', uniqueKey: 'one' })
    await takeNextJob(database.db, 'a-worker-that-died')

    expect(await takeNextJob(database.db, 'another')).toBeNull()
    expect(await disownJobs(database.db)).toBe(1)
    expect((await takeNextJob(database.db, 'another'))?.type).toBe('Scan')
  })
})

describe('the worker', () => {
  it('runs a scan, then analyses the books it found', async () => {
    const { database } = await setupLibrary()
    const log = logger()
    await enqueueJob(database.db, {
      type: 'ScanLibrary',
      uniqueKey: scanKey('L1'),
      priority: JOB_PRIORITY.HIGH,
      payload: { libraryId: 'L1' },
    })

    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      const book = await until(async () => {
        const rows = await database.db.selectFrom('books').selectAll().execute()
        return rows.length > 0 ? rows[0] : null
      })
      expect(book.name).toBe('Volume 1')

      // The scan queued the new book for analysis, and the worker ran that too.
      await until(async () => (await database.db.selectFrom('media').selectAll().execute()).length > 0)

      // The document the book carries was read, and what it says about the series
      // was folded into the series' own metadata.
      await until(async () => {
        const author = await database.db
          .selectFrom('book_metadata_author')
          .select('name')
          .where('book_id', '=', book.id)
          .executeTakeFirst()
        return author?.name === 'Katsuhiro Otomo'
      })
      const series = await database.db.selectFrom('series_metadata').selectAll().executeTakeFirstOrThrow()
      expect(series.title).toBe('Akira')

      // Analysing a book gives it a poster, made from its first page.
      const poster = await until(async () => {
        const rows = await database.db.selectFrom('thumbnails').selectAll().execute()
        return rows[0]
      })
      expect(poster.type).toBe('GENERATED')
      expect(poster.selected).toBe(1)
      expect(poster.height).toBe(300)

      // And nothing is left behind: the queue is empty once the work is done.
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)
    } finally {
      await worker.stop()
    }
  })

  it('drops a job that fails, and says so', async () => {
    const { database } = await setupLibrary()
    const log = logger()
    await enqueueJob(database.db, {
      type: 'ScanLibrary',
      uniqueKey: 'SCANLIBRARY_GONE',
      payload: { libraryId: 'GONE' },
    })

    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)
      expect(log.messages.some((entry) => entry.level === 'error' && entry.message === 'job failed')).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  it('remakes the posters the server has outgrown', async () => {
    const { database } = await setupLibrary()
    const log = logger()
    await enqueueJob(database.db, {
      type: 'ScanLibrary',
      uniqueKey: scanKey('L1'),
      payload: { libraryId: 'L1' },
    })

    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      const stored = async () => (await database.db.selectFrom('thumbnails').selectAll().execute())[0]
      const first = await until(stored)
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)

      // Asking for the bigger ones only replaces a poster that is too small for
      // the size in force now.
      await setSetting(database.db, SETTING_KEYS.thumbnailSize, 'MEDIUM')
      await enqueueJob(database.db, {
        type: 'RegenerateBookThumbnails',
        uniqueKey: 'thumbs',
        payload: { forBiggerResultOnly: true },
      })

      const remade = await until(async () => {
        const row = await stored()
        return row !== undefined && row.height > 300 ? row : null
      })
      expect(remade.width).toBe(400)
      expect(remade.height).toBe(600)
      // The same book, and still only one poster: it is replaced, not added to.
      expect(remade.owner_id).toBe(first.owner_id)
      expect(remade.id).not.toBe(first.id)
      expect(await database.db.selectFrom('thumbnails').selectAll().execute()).toHaveLength(1)
      expect(log.messages.some((entry) => entry.level === 'error')).toBe(false)
    } finally {
      await worker.stop()
    }
  })

  it('says when a job type is one it does not know', async () => {
    const { database } = await setupLibrary()
    const log = logger()
    await enqueueJob(database.db, { type: 'DoSomethingElse', uniqueKey: 'mystery', payload: {} })

    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)
      expect(log.messages.some((entry) => entry.message === 'unknown job type')).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  it('scans a library that asks to be scanned on startup', async () => {
    const { database } = await setupLibrary()
    await database.db.updateTable('libraries').set({ scan_on_startup: 1 }).where('id', '=', 'L1').execute()

    const worker = await startJobWorker({ db: database.db, log: logger(), schedule: false })
    try {
      await until(async () => (await database.db.selectFrom('series').selectAll().execute()).length === 1)
    } finally {
      await worker.stop()
    }
  })

  it('keeps the unique key a scheduled scan is queued under, so it collapses with the API', async () => {
    const { database } = await setupLibrary()
    await database.db.updateTable('libraries').set({ scan_on_startup: 1 }).where('id', '=', 'L1').execute()

    const worker = await startJobWorker({ db: database.db, log: logger(), schedule: false })
    try {
      const queued = await until(async () => {
        const rows = await database.db.selectFrom('jobs').select('unique_key').execute()
        return rows[0]?.unique_key
      })
      expect(queued).toBe(scanKey('L1'))
    } finally {
      await worker.stop()
    }
  })

  it('does not schedule a library whose interval is disabled', async () => {
    const { database } = await setupLibrary()
    await database.db.updateTable('libraries').set({ scan_interval: 'DISABLED' }).where('id', '=', 'L1').execute()

    const worker = await startJobWorker({ db: database.db, log: logger() })
    try {
      // Long enough for a handful of ticks, which is when the schedule is looked at.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await database.db.selectFrom('jobs').selectAll().execute()).toHaveLength(0)
      expect(await database.db.selectFrom('series').selectAll().execute()).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  it('releases a job that was still claimed when the worker stopped', async () => {
    const { database } = await setupLibrary()
    await enqueueJob(database.db, { type: 'ScanLibrary', uniqueKey: scanKey('L1'), payload: { libraryId: 'L1' } })
    await takeNextJob(database.db, 'a-worker-that-died')

    const worker = await startJobWorker({ db: database.db, log: logger(), schedule: false })
    try {
      await until(async () => (await database.db.selectFrom('series').selectAll().execute()).length === 1)
    } finally {
      await worker.stop()
    }
  })
})
