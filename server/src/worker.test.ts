import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import yauzl from 'yauzl'
import { createDatabase, type Database } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import { EventBus } from './events.js'
import { fileHash } from './hashing/hashes.js'
import type { JobLogger } from './handlers.js'
import {
  JOB_PRIORITY,
  MAX_JOB_ATTEMPTS,
  disownJobs,
  enqueueJob,
  enqueueJobs,
  failJob,
  finishJob,
  takeNextJob,
} from './jobs.js'
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

/** Read a ZIP back with an independent reader, to check what a rewrite wrote. */
function readZip(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) return reject(error ?? new Error('not a zip'))
      const entries: { name: string; data: Buffer }[] = []
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('no entry stream'))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) })
            zipfile.readEntry()
          })
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

/** A library holding one CBZ that carries a ComicInfo document. */
async function setupLibrary(pageCount = 1): Promise<{ database: Database; libraryId: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-worker-'))
  mkdirSync(join(root, 'Akira'), { recursive: true })

  const entries: { name: string; data: Buffer }[] = []
  for (let number = 1; number <= pageCount; number += 1) entries.push({ name: `page${number}.jpg`, data: await page() })
  entries.push({
    name: 'ComicInfo.xml',
    data: Buffer.from('<ComicInfo><Series>Akira</Series><Writer>Katsuhiro Otomo</Writer></ComicInfo>', 'utf8'),
  })

  writeFileSync(join(root, 'Akira', 'Volume 1.cbz'), writeZip(entries))

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

    await finishJob(database.db, first!.id)
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

  it('hashes a book and its pages when the library asks for it', async () => {
    const { database, root } = await setupLibrary()
    await database.db.updateTable('libraries').set({ hash_pages: 1, hash_koreader: 1 }).where('id', '=', 'L1').execute()

    const log = logger()
    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      await enqueueJob(database.db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey('L1'),
        priority: JOB_PRIORITY.HIGH,
        payload: { libraryId: 'L1' },
      })

      // The file itself is hashed by the scan that found the book, which is what
      // makes a book recognisable again after it moves.
      const book = await until(async () => {
        const row = await database.db.selectFrom('books').selectAll().executeTakeFirst()
        return row && row.file_hash ? row : null
      })
      expect(book.file_hash).toBe(await fileHash(join(root, 'Akira', 'Volume 1.cbz')))

      await until(async () => {
        const row = await database.db.selectFrom('books').select('file_hash_koreader').executeTakeFirst()
        return row?.file_hash_koreader !== null && row?.file_hash_koreader !== ''
      })

      // The pages are not hashed yet: the scan asked for hashing before the book it
      // had just added was analysed, so it found no page list to hash - which is what
      // the reference's scan does too.
      const pages = await database.db.selectFrom('media_page').selectAll().execute()
      expect(pages.every((row) => row.file_hash === '')).toBe(true)

      // So the next scan - of a library that has not changed - does it, which is
      // how a second scan of the same library is worth as much as the first.
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)
      await enqueueJob(database.db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey('L1'),
        priority: JOB_PRIORITY.HIGH,
        payload: { libraryId: 'L1' },
      })

      const page = await until(async () => {
        const row = await database.db.selectFrom('media_page').selectAll().executeTakeFirst()
        return row && row.file_hash ? row : null
      })
      expect(page.file_hash).toMatch(/^[0-9a-f]{32}$/)
      expect(log.messages.some((entry) => entry.message === 'HashBookPages: hashed')).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  it('removes a duplicate page, and says the book changed', async () => {
    const { database, root, libraryId } = await setupLibrary(2)
    const log = logger()
    const events = new EventBus()
    const announced: string[] = []
    events.subscribe((event) => announced.push(event.name))

    const worker = await startJobWorker({ db: database.db, log, schedule: false, events })
    try {
      // A scan finds the book and analyses it, which is what gives it pages to name.
      await enqueueJob(database.db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey(libraryId),
        priority: JOB_PRIORITY.HIGH,
        payload: { libraryId },
      })

      const pages = await until(async () => {
        const rows = await database.db.selectFrom('media_page').selectAll().orderBy('number').execute()
        return rows.length === 2 ? rows : null
      })
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)

      const book = await database.db.selectFrom('books').selectAll().executeTakeFirstOrThrow()
      const page = pages[0]!
      await enqueueJob(database.db, {
        type: 'RemoveHashedPages',
        uniqueKey: `REMOVE_HASHED_PAGES_${book.id}`,
        priority: JOB_PRIORITY.HIGH,
        payload: {
          bookId: book.id,
          pages: [
            {
              fileName: page.file_name,
              mediaType: page.media_type,
              fileHash: page.file_hash,
              fileSize: page.file_size,
              pageNumber: page.number,
            },
          ],
        },
      })

      // The book describes one page again, and the file itself no longer holds it.
      const remaining = await until(async () => {
        const rows = await database.db.selectFrom('media_page').selectAll().orderBy('number').execute()
        return rows.length === 1 ? rows : null
      })
      expect(remaining[0]!.file_name).toBe('page2.jpg')
      expect((await readZip(readFileSync(join(root, 'Akira', 'Volume 1.cbz')))).map((entry) => entry.name)).toEqual([
        'page2.jpg',
        'ComicInfo.xml',
      ])

      // The poster is made of the first page, which is the page that went, so a new
      // one is made - and a client is told the book changed either way.
      await until(async () => {
        const thumbnails = await database.db.selectFrom('thumbnails').selectAll().execute()
        return thumbnails.some((row) => row.selected === 1 && row.page === 1) ? thumbnails : null
      })
      expect(announced).toContain('BookChanged')
    } finally {
      await worker.stop()
    }
  })

  it('tries a job that fails again, then gives up where somebody can find it', async () => {
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
      await until(async () => (await database.db.selectFrom('historical_events').selectAll().execute()).length > 0)

      const retried = log.messages.filter((entry) => entry.message === 'job failed, and will be tried again')
      expect(retried.map((entry) => entry.context.attempt)).toEqual([1, 2])
      expect(log.messages.filter((entry) => entry.message === 'job failed, and was given up on')).toHaveLength(1)

      const events = await database.db.selectFrom('historical_events').selectAll().execute()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'TaskFailed', book_id: null, series_id: null })
      expect(JSON.parse(events[0]!.properties)).toEqual({
        task: 'ScanLibrary',
        reason: 'library GONE does not exist',
        attempts: String(MAX_JOB_ATTEMPTS),
        library: 'GONE',
      })
    } finally {
      await worker.stop()
    }
  })

  it('runs a job once more when it was asked for while it ran', async () => {
    const { database } = await setupLibrary()
    const again = { type: 'ScanLibrary', uniqueKey: scanKey('L1'), payload: { libraryId: 'L1' } }
    await enqueueJob(database.db, again)

    const running = await takeNextJob(database.db, 'w1')
    expect(running?.type).toBe('ScanLibrary')
    // Somebody asks for a scan while this one is under way.
    await enqueueJob(database.db, { ...again, payload: { libraryId: 'L1', scanDeep: true } })
    expect(await takeNextJob(database.db, 'w2')).toBeNull()

    expect(await finishJob(database.db, running!.id)).toBe('REQUEUED')
    const next = await takeNextJob(database.db, 'w1')
    // It is the request that was made, and it starts with a clean record.
    expect(next).toMatchObject({ id: running!.id, attempts: 1, payload: { libraryId: 'L1', scanDeep: true } })

    expect(await finishJob(database.db, next!.id)).toBe('DONE')
    expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  })

  it('does not mark a job that was only waiting', async () => {
    const { database } = await setupLibrary()
    const job = { type: 'ScanLibrary', uniqueKey: scanKey('L1'), payload: { libraryId: 'L1' } }
    await enqueueJob(database.db, job)
    await enqueueJob(database.db, job)

    const running = await takeNextJob(database.db, 'w1')
    expect(await finishJob(database.db, running!.id)).toBe('DONE')
  })

  it('keeps a request made during a run that was given up on', async () => {
    const { database } = await setupLibrary()
    const job = { type: 'ScanLibrary', uniqueKey: scanKey('L1'), payload: { libraryId: 'L1' } }
    await enqueueJob(database.db, job)

    let running = await takeNextJob(database.db, 'w1')
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      expect(await failJob(database.db, running!)).toBe('RETRY')
      running = await takeNextJob(database.db, 'w1')
      expect(running?.attempts).toBe(attempt + 1)
    }
    await enqueueJob(database.db, job)
    expect(await failJob(database.db, running!)).toBe('GAVE_UP')

    expect((await takeNextJob(database.db, 'w1'))?.attempts).toBe(1)
  })

  it('queues many jobs together or not at all', async () => {
    const { database } = await setupLibrary()
    const job = (key: string, type: string | null) => ({ type: type as string, uniqueKey: key, payload: {} })

    await expect(enqueueJobs(database.db, [job('A', 'One'), job('B', 'Two'), job('C', null)])).rejects.toThrow()
    expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])

    await enqueueJobs(database.db, [job('A', 'One'), job('B', 'Two')])
    await enqueueJobs(database.db, [])
    expect((await database.db.selectFrom('jobs').select('unique_key').execute()).map((row) => row.unique_key)).toEqual([
      'A',
      'B',
    ])
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

  it('looks for artwork beside a book, and drops it when the file goes', async () => {
    const { database, root } = await setupLibrary()
    const cover = join(root, 'Akira', 'Volume 1.png')
    writeFileSync(cover, await page())

    const worker = await startJobWorker({ db: database.db, log: logger(), schedule: false })
    try {
      await enqueueJob(database.db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey('L1'),
        payload: { libraryId: 'L1' },
      })

      // Analysing the book looks beside it, which is where a cover from a scan comes from.
      const artwork = await until(async () => {
        const rows = await database.db.selectFrom('thumbnails').selectAll().where('type', '=', 'SIDECAR').execute()
        return rows[0]
      })
      expect(artwork.url).toMatch(/Volume 1\.png$/)
      // The file is not copied into the database.
      expect(artwork.thumbnail).toBeNull()

      const book = await database.db.selectFrom('books').select('id').executeTakeFirstOrThrow()
      rmSync(cover)
      await enqueueJob(database.db, {
        type: 'RefreshBookLocalArtwork',
        uniqueKey: `REFRESH_BOOK_LOCAL_ARTWORK_${book.id}`,
        payload: { bookId: book.id },
      })

      await until(async () => {
        const rows = await database.db.selectFrom('thumbnails').selectAll().where('type', '=', 'SIDECAR').execute()
        return rows.length === 0
      })
    } finally {
      await worker.stop()
    }
  })

  it('deletes a book file, and says the book is gone', async () => {
    const { database, root, libraryId } = await setupLibrary()
    const log = logger()
    const events = new EventBus()
    const announced: { name: string; data: unknown }[] = []
    events.subscribe((event) => announced.push({ name: event.name, data: event.data }))

    const worker = await startJobWorker({ db: database.db, log, schedule: false, events })
    try {
      await enqueueJob(database.db, {
        type: 'ScanLibrary',
        uniqueKey: scanKey(libraryId),
        priority: JOB_PRIORITY.HIGH,
        payload: { libraryId },
      })
      const book = await until(async () =>
        database.db.selectFrom('books').select(['id', 'series_id']).executeTakeFirst(),
      )
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)

      await enqueueJob(database.db, {
        type: 'DeleteBookFile',
        uniqueKey: `DELETE_BOOK_${book.id}`,
        payload: { bookId: book.id },
      })
      await until(async () => announced.some((event) => event.name === 'BookDeleted'))

      expect(existsSync(join(root, 'Akira', 'Volume 1.cbz'))).toBe(false)
      expect(announced.find((event) => event.name === 'BookDeleted')?.data).toEqual({
        bookId: book.id,
        seriesId: book.series_id,
        libraryId,
      })
      const row = await database.db.selectFrom('books').select('deleted_date').executeTakeFirst()
      expect(row?.deleted_date).not.toBeNull()

      // The series goes the same way.
      await enqueueJob(database.db, {
        type: 'DeleteSeriesFile',
        uniqueKey: `DELETE_SERIES_${book.series_id}`,
        payload: { seriesId: book.series_id },
      })
      await until(async () => announced.some((event) => event.name === 'SeriesDeleted'))
      expect(announced.find((event) => event.name === 'SeriesDeleted')?.data).toEqual({
        seriesId: book.series_id,
        libraryId,
      })
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

  it('takes the next job as soon as one finishes, not at the next tick', async () => {
    const { database } = await setupLibrary()
    const log = logger()
    // Twenty jobs that do nothing. One at a time and half a second apart, they
    // would take ten seconds.
    for (let index = 0; index < 20; index += 1) {
      await enqueueJob(database.db, { type: 'DoNothing', uniqueKey: `nothing-${index}`, payload: {} })
    }

    const started = Date.now()
    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      await until(async () => (await database.db.selectFrom('jobs').selectAll().execute()).length === 0)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(log.messages.filter((entry) => entry.message === 'unknown job type')).toHaveLength(20)
    } finally {
      await worker.stop()
    }
  })

  it('never runs more jobs at once than the pool allows', async () => {
    const { database } = await setupLibrary()
    await setSetting(database.db, SETTING_KEYS.taskPoolSize, '2')

    // A job is claimed while it runs, so the queue says how many are running. It
    // is looked at as often as the wait allows, which samples rather than proves.
    let most = 0
    const log = logger()
    for (let index = 0; index < 12; index += 1) {
      await enqueueJob(database.db, { type: 'DoNothing', uniqueKey: `nothing-${index}`, payload: {} })
    }

    const worker = await startJobWorker({ db: database.db, log, schedule: false })
    try {
      await until(async () => {
        const jobs = await database.db.selectFrom('jobs').select('owner').execute()
        most = Math.max(most, jobs.filter((job) => job.owner !== null).length)
        return jobs.length === 0
      })
      expect(most).toBeLessThanOrEqual(2)
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
