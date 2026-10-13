import { beforeEach, describe, expect, it } from 'vitest'

import { createDatabase, type Database } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import { metricNames, parseTags, readMetric, recordTask, resetTaskMetrics } from './metrics.js'

const NOW = '2026-01-01T00:00:00.000Z'

async function setup(): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db

  for (const [id, name] of [
    ['L1', 'Manga'],
    ['L2', 'Comics'],
    ['L3', 'Empty'],
  ] as const) {
    await db
      .insertInto('libraries')
      .values({ id, name, root: `/${name}`, created_date: NOW, last_modified_date: NOW } as never)
      .execute()
  }

  const series = async (id: string, libraryId: string, deleted = false) =>
    db
      .insertInto('series')
      .values({
        id,
        library_id: libraryId,
        name: id,
        url: `file:///${id}`,
        file_last_modified: NOW,
        created_date: NOW,
        last_modified_date: NOW,
        deleted_date: deleted ? NOW : null,
      } as never)
      .execute()
  const book = async (id: string, seriesId: string, libraryId: string, size: number, deleted = false) =>
    db
      .insertInto('books')
      .values({
        id,
        series_id: seriesId,
        library_id: libraryId,
        name: id,
        url: `file:///${id}`,
        file_last_modified: NOW,
        file_size: size,
        created_date: NOW,
        last_modified_date: NOW,
        deleted_date: deleted ? NOW : null,
      } as never)
      .execute()

  await series('S1', 'L1')
  await series('S2', 'L1')
  await series('S3', 'L2')
  await series('S4', 'L2', true)
  await book('B1', 'S1', 'L1', 100)
  await book('B2', 'S1', 'L1', 250)
  await book('B3', 'S3', 'L2', 1000)
  await book('B4', 'S4', 'L2', 5000, true)

  return database
}

describe('what the libraries hold', () => {
  it('counts series and books in every library, leaving out what is in the trash', async () => {
    const { db } = await setup()

    const series = await readMetric(db, 'komga.series')
    expect(series?.measurements).toEqual([{ statistic: 'VALUE', value: 3 }])
    // By name, and an empty library is one of them.
    expect(series?.availableTags).toEqual([{ tag: 'library', values: ['L2', 'L3', 'L1'] }])

    expect((await readMetric(db, 'komga.books'))?.measurements).toEqual([{ statistic: 'VALUE', value: 3 }])
  })

  it('narrows to one library', async () => {
    const { db } = await setup()
    const one = async (name: string, library: string) =>
      (await readMetric(db, name, [{ key: 'library', value: library }]))?.measurements[0]?.value

    expect(await one('komga.series', 'L1')).toBe(2)
    expect(await one('komga.series', 'L2')).toBe(1)
    expect(await one('komga.books', 'L2')).toBe(1)
    expect(await one('komga.books', 'L3')).toBe(0)
    expect((await readMetric(db, 'komga.books', [{ key: 'library', value: 'L1' }]))?.availableTags).toEqual([])
  })

  it('adds up the size of the files, in bytes', async () => {
    const { db } = await setup()

    const all = await readMetric(db, 'komga.books.filesize')
    expect(all).toMatchObject({ baseUnit: 'bytes', measurements: [{ statistic: 'VALUE', value: 1350 }] })
    const one = await readMetric(db, 'komga.books.filesize', [{ key: 'library', value: 'L1' }])
    expect(one?.measurements[0]?.value).toBe(350)
  })

  it('counts covers found beside books and series', async () => {
    const { db } = await setup()
    const thumbnail = (id: string, ownerType: string, ownerId: string, type: string) =>
      db
        .insertInto('thumbnails')
        .values({
          id,
          owner_type: ownerType,
          owner_id: ownerId,
          type,
          selected: 0,
          media_type: 'image/jpeg',
          width: 10,
          height: 14,
          file_size: 100,
          created_date: NOW,
          last_modified_date: NOW,
        } as never)
        .execute()
    await thumbnail('T1', 'BOOK', 'B1', 'SIDECAR')
    await thumbnail('T2', 'SERIES', 'S1', 'SIDECAR')
    await thumbnail('T3', 'BOOK', 'B3', 'GENERATED')
    await thumbnail('T4', 'BOOK', 'B4', 'SIDECAR')

    expect((await readMetric(db, 'komga.sidecars'))?.measurements[0]?.value).toBe(2)
    expect((await readMetric(db, 'komga.sidecars', [{ key: 'library', value: 'L2' }]))?.measurements[0]?.value).toBe(0)
  })

  it('counts collections and read lists, which belong to no library', async () => {
    const { db } = await setup()
    await db
      .insertInto('collections')
      .values({ id: 'C1', name: 'Best', created_date: NOW, last_modified_date: NOW } as never)
      .execute()

    expect(await readMetric(db, 'komga.collections')).toMatchObject({
      measurements: [{ statistic: 'VALUE', value: 1 }],
      availableTags: [],
    })
    expect((await readMetric(db, 'komga.readlists'))?.measurements[0]?.value).toBe(0)
    expect(await readMetric(db, 'komga.collections', [{ key: 'library', value: 'L1' }])).toBeNull()
  })

  it('has no tag to offer on a server with no library', async () => {
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)

    expect(await readMetric(database.db, 'komga.books')).toMatchObject({
      measurements: [{ statistic: 'VALUE', value: 0 }],
      availableTags: [],
    })
  })

  it('knows nothing of a name, a tag or a library that is not there', async () => {
    const { db } = await setup()

    expect(await readMetric(db, 'komga.nothing')).toBeNull()
    expect(await readMetric(db, 'komga.books', [{ key: 'type', value: 'L1' }])).toBeNull()
    expect(await readMetric(db, 'komga.books', [{ key: 'library', value: 'L9' }])).toBeNull()
  })
})

describe('what the worker has done', () => {
  beforeEach(() => resetTaskMetrics())

  it('is nothing before anything has run', async () => {
    const { db } = await setup()

    expect(await readMetric(db, 'komga.tasks.execution')).toEqual({
      name: 'komga.tasks.execution',
      description: 'Jobs the worker has run since the server started',
      baseUnit: 'seconds',
      measurements: [
        { statistic: 'COUNT', value: 0 },
        { statistic: 'TOTAL_TIME', value: 0 },
        { statistic: 'MAX', value: 0 },
      ],
      availableTags: [],
    })
  })

  it('counts each kind of job and the time it took, in seconds', async () => {
    const { db } = await setup()
    recordTask('ScanLibrary', 1500)
    recordTask('AnalyzeBook', 200)
    recordTask('AnalyzeBook', 300)

    const all = await readMetric(db, 'komga.tasks.execution')
    expect(all?.measurements).toEqual([
      { statistic: 'COUNT', value: 3 },
      { statistic: 'TOTAL_TIME', value: 2 },
      { statistic: 'MAX', value: 1.5 },
    ])
    expect(all?.availableTags).toEqual([{ tag: 'type', values: ['AnalyzeBook', 'ScanLibrary'] }])

    const analysis = await readMetric(db, 'komga.tasks.execution', [{ key: 'type', value: 'AnalyzeBook' }])
    expect(analysis?.measurements).toEqual([
      { statistic: 'COUNT', value: 2 },
      { statistic: 'TOTAL_TIME', value: 0.5 },
      { statistic: 'MAX', value: 0.3 },
    ])
    expect(await readMetric(db, 'komga.tasks.execution', [{ key: 'type', value: 'HashBook' }])).toBeNull()
  })
})

describe('asking', () => {
  it('lists the names', () => {
    expect(metricNames()).toEqual([
      'komga.books',
      'komga.books.filesize',
      'komga.collections',
      'komga.readlists',
      'komga.series',
      'komga.sidecars',
      'komga.tasks.execution',
    ])
  })

  it('reads one tag or several out of a query', () => {
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags('library:L1')).toEqual([{ key: 'library', value: 'L1' }])
    expect(parseTags(['library:L1', 'type:a:b'])).toEqual([
      { key: 'library', value: 'L1' },
      { key: 'type', value: 'a:b' },
    ])
    expect(parseTags('library')).toBeNull()
    expect(parseTags(':L1')).toBeNull()
    expect(parseTags('library:')).toBeNull()
  })
})
