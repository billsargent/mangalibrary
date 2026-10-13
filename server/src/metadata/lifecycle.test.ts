import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { writeZip } from '../testing/zip.js'
import { scanKey, startJobWorker } from '../worker.js'

/**
 * What a library's metadata is after the scan, the analysis and the refreshes have
 * all run, which is what a person sees - each step is tested on its own elsewhere,
 * and what goes wrong between them is not.
 */

const log = { debug() {}, info() {}, warn() {}, error() {} }

async function comic(fields: string): Promise<Buffer> {
  const page = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#335577' } })
    .jpeg()
    .toBuffer()
  return writeZip([
    { name: 'p1.jpg', data: page },
    { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo>${fields}</ComicInfo>`) },
  ])
}

interface Library {
  database: Database
  root: string
  /** Scan the library and wait for everything the scan set going. */
  scan: () => Promise<void>
  /** Wait for the queue to empty and stay empty. */
  idle: () => Promise<void>
  stop: () => Promise<void>
}

async function library(switches: Record<string, number> = {}): Promise<Library> {
  const root = mkdtempSync(join(tmpdir(), 'ml-lifecycle-'))
  mkdirSync(join(root, '_oneshots'))
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  await database.db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      oneshots_directory: '_oneshots',
      created_date: 'now',
      last_modified_date: 'now',
      ...switches,
    } as never)
    .execute()

  const worker = await startJobWorker({ db: database.db, log, schedule: false })
  const idle = async (): Promise<void> => {
    for (let quiet = 0; quiet < 5;) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      quiet = (await database.db.selectFrom('jobs').select('id').execute()).length === 0 ? quiet + 1 : 0
    }
  }
  let scans = 0
  const scan = async (): Promise<void> => {
    // A folder's date is coarse on some disks; a scan that follows a change at once
    // must still see the folder as changed.
    scans += 1
    const later = new Date(Date.now() + scans * 60_000)
    for (const folder of ['Akira', '_oneshots']) {
      try {
        utimesSync(join(root, folder), later, later)
      } catch {
        // Not every test has every folder.
      }
    }
    await enqueueJob(database.db, {
      type: 'ScanLibrary',
      uniqueKey: scanKey('L1'),
      priority: JOB_PRIORITY.HIGH,
      payload: { libraryId: 'L1' },
    })
    await idle()
  }
  return { database, root, scan, idle, stop: () => worker.stop() }
}

const numbers = async (database: Database) =>
  (
    await database.db
      .selectFrom('books')
      .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
      .select(['books.name', 'books.number as position', 'book_metadata.number', 'book_metadata.number_sort'])
      .where('books.deleted_date', 'is', null)
      .orderBy('books.name')
      .execute()
  ).map((row) => [row.name, row.position, row.number, row.number_sort])

describe('a book’s number, when its series changes', () => {
  it('is still what the book says after a book is added before it', async () => {
    const { database, root, scan, stop } = await library()
    try {
      mkdirSync(join(root, 'Akira'))
      writeFileSync(join(root, 'Akira', 'b.cbz'), await comic('<Series>Akira</Series><Number>5.5</Number>'))
      writeFileSync(join(root, 'Akira', 'c.cbz'), await comic('<Series>Akira</Series><Number>7</Number>'))
      await scan()
      expect(await numbers(database)).toEqual([
        ['b', 1, '5.5', 5.5],
        ['c', 2, '7', 7],
      ])

      // A book that sorts first moves the other two down a place each.
      writeFileSync(join(root, 'Akira', 'a.cbz'), await comic('<Series>Akira</Series><Number>2</Number>'))
      await scan()

      expect(await numbers(database)).toEqual([
        ['a', 1, '2', 2],
        ['b', 2, '5.5', 5.5],
        ['c', 3, '7', 7],
      ])
    } finally {
      await stop()
    }
  }, 30_000)

  it('is left alone when a book is added after it, without reading the book again', async () => {
    const { database, root, scan, stop } = await library()
    try {
      mkdirSync(join(root, 'Akira'))
      writeFileSync(join(root, 'Akira', 'a.cbz'), await comic('<Series>Akira</Series><Number>5.5</Number>'))
      await scan()
      const before = await database.db.selectFrom('book_metadata').select('last_modified_date').execute()

      writeFileSync(join(root, 'Akira', 'b.cbz'), await comic('<Series>Akira</Series>'))
      await scan()

      // The new book says nothing, so it is numbered by its place.
      expect(await numbers(database)).toEqual([
        ['a', 1, '5.5', 5.5],
        ['b', 2, '2', 2],
      ])
      const after = await database.db
        .selectFrom('book_metadata')
        .innerJoin('books', 'books.id', 'book_metadata.book_id')
        .select('book_metadata.last_modified_date')
        .where('books.name', '=', 'a')
        .execute()
      expect(after).toEqual(before)
    } finally {
      await stop()
    }
  }, 30_000)

  it('follows its place when the book says nothing', async () => {
    const { database, root, scan, stop } = await library()
    try {
      mkdirSync(join(root, 'Akira'))
      writeFileSync(join(root, 'Akira', 'b.cbz'), await comic('<Series>Akira</Series>'))
      await scan()
      writeFileSync(join(root, 'Akira', 'a.cbz'), await comic('<Series>Akira</Series>'))
      await scan()

      expect(await numbers(database)).toEqual([
        ['a', 1, '1', 1],
        ['b', 2, '2', 2],
      ])
    } finally {
      await stop()
    }
  }, 30_000)
})

describe('a oneshot’s series', () => {
  it('takes its book’s title and summary once the book has been read', async () => {
    const { database, root, scan, stop } = await library()
    try {
      writeFileSync(
        join(root, '_oneshots', 'file name.cbz'),
        await comic('<Title>The Real Title</Title><Summary>What it is about</Summary>'),
      )
      await scan()

      const series = await database.db
        .selectFrom('series_metadata')
        .select(['title', 'title_sort', 'summary', 'status', 'total_book_count'])
        .executeTakeFirstOrThrow()
      expect(series).toEqual({
        title: 'The Real Title',
        title_sort: 'The Real Title',
        summary: 'What it is about',
        status: 'ENDED',
        total_book_count: 1,
      })
    } finally {
      await stop()
    }
  }, 30_000)
})

describe('the four ComicInfo switches', () => {
  const FIELDS =
    '<Series>Real Series</Series><Title>Real Title</Title><SeriesGroup>Group A</SeriesGroup>' +
    '<StoryArc>The Arc</StoryArc><StoryArcNumber>2</StoryArcNumber>'

  it('take collections and read lists without taking the book’s or the series’ fields', async () => {
    const { database, root, scan, stop } = await library({ import_comic_info_book: 0, import_comic_info_series: 0 })
    try {
      mkdirSync(join(root, 'Akira'))
      writeFileSync(join(root, 'Akira', 'a.cbz'), await comic(FIELDS))
      await scan()

      expect((await database.db.selectFrom('collections').select('name').execute()).map((row) => row.name)).toEqual([
        'Group A',
      ])
      expect((await database.db.selectFrom('readlists').select('name').execute()).map((row) => row.name)).toEqual([
        'The Arc',
      ])
      // The fields were not asked for, and are what the files' names made them.
      expect(await database.db.selectFrom('series_metadata').select('title').execute()).toEqual([{ title: 'Akira' }])
      expect(await database.db.selectFrom('book_metadata').select('title').execute()).toEqual([{ title: 'a' }])
    } finally {
      await stop()
    }
  }, 30_000)

  it('take the fields without the collections and read lists', async () => {
    const { database, root, scan, stop } = await library({
      import_comic_info_collection: 0,
      import_comic_info_read_list: 0,
    })
    try {
      mkdirSync(join(root, 'Akira'))
      writeFileSync(join(root, 'Akira', 'a.cbz'), await comic(FIELDS))
      await scan()

      expect(await database.db.selectFrom('collections').select('name').execute()).toEqual([])
      expect(await database.db.selectFrom('readlists').select('name').execute()).toEqual([])
      expect(await database.db.selectFrom('series_metadata').select('title').execute()).toEqual([
        { title: 'Real Series' },
      ])
      expect(await database.db.selectFrom('book_metadata').select('title').execute()).toEqual([{ title: 'Real Title' }])
    } finally {
      await stop()
    }
  }, 30_000)
})
