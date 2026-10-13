import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { analyzeBook } from '../media/analyze.js'
import { writeZip } from '../testing/zip.js'
import { walkLibrary } from './library.js'
import { scanLibrary } from './reconcile.js'

const picture = (width: number): Promise<Buffer> =>
  sharp({ create: { width, height: 6, channels: 3, background: '#224466' } })
    .png()
    .toBuffer()

const mylar = (name: string): string =>
  JSON.stringify({ metadata: { name, publisher: 'Kodansha', year: 1982, status: 'Ended', total_issues: 6 } })

/**
 * Change a file where it lies, and leave its folder's date as it was: the case a
 * scan that only looked at folders would miss.
 */
function writeInPlace(path: string, content: string | Buffer, minutesLater: number): void {
  const folder = join(path, '..')
  const before = statSync(folder)
  writeFileSync(path, content)
  const later = new Date(Date.now() + minutesLater * 60_000)
  utimesSync(path, later, later)
  utimesSync(folder, before.atime, before.mtime)
}

async function setup(): Promise<{ database: Database; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-sidecars-'))
  mkdirSync(join(root, 'Akira'))
  writeFileSync(join(root, 'Akira', 'Volume 1.cbz'), writeZip([{ name: '1.png', data: await picture(4) }]))
  writeFileSync(join(root, 'Akira', 'Volume 2.cbz'), writeZip([{ name: '1.png', data: await picture(5) }]))

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: 'now', last_modified_date: 'now' } as never)
    .execute()
  return { database, root }
}

const sidecars = async (database: Database) =>
  (await database.db.selectFrom('sidecars').selectAll().orderBy('url').execute()).map((row) => [
    decodeURIComponent(basename(row.url)),
    row.source,
    row.type,
  ])
const posters = (database: Database, owner: 'BOOK' | 'SERIES') =>
  database.db
    .selectFrom('thumbnails')
    .select(['id', 'url', 'width', 'selected'])
    .where('owner_type', '=', owner)
    .where('type', '=', 'SIDECAR')
    .execute()
const queued = async (database: Database) =>
  (await database.db.selectFrom('jobs').select('type').execute()).map((job) => job.type)

describe('what a walk finds beside the books', () => {
  it('tells a series’ files from a book’s, and ignores the rest', async () => {
    const { root } = await setup()
    writeFileSync(join(root, 'Akira', 'cover.jpg'), await picture(4))
    writeFileSync(join(root, 'Akira', 'series.json'), mylar('Akira'))
    writeFileSync(join(root, 'Akira', 'Volume 1.png'), await picture(4))
    writeFileSync(join(root, 'Akira', 'volume 1-2.JPG'), await picture(4))
    writeFileSync(join(root, 'Akira', 'holiday.jpg'), await picture(4))
    writeFileSync(join(root, 'Akira', 'notes.txt'), 'mine')

    const [series] = await walkLibrary(root, {
      scanCbx: true,
      scanPdf: true,
      scanEpub: true,
      oneshotsDirectory: null,
      exclusions: [],
      forceDirectoryModifiedTime: false,
    })

    expect(series!.books.map((book) => book.name)).toEqual(['Volume 1', 'Volume 2'])
    expect(
      series!.sidecars
        .map((sidecar) => [basename(sidecar.path), sidecar.source, sidecar.type, basename(sidecar.parent)])
        .sort(),
    ).toEqual([
      ['Volume 1.png', 'BOOK', 'ARTWORK', 'Volume 1.cbz'],
      ['cover.jpg', 'SERIES', 'ARTWORK', 'Akira'],
      ['series.json', 'SERIES', 'METADATA', 'Akira'],
      ['volume 1-2.JPG', 'BOOK', 'ARTWORK', 'Volume 1.cbz'],
    ])
  })
})

describe('a scan, when only a file beside the books changed', () => {
  it('reads a series.json that was edited where it lies', async () => {
    const { database, root } = await setup()
    writeFileSync(join(root, 'Akira', 'series.json'), mylar('Akira'))
    await scanLibrary(database.db, 'L1')
    expect(await database.db.selectFrom('series_metadata').select('title').execute()).toEqual([{ title: 'Akira' }])

    writeInPlace(join(root, 'Akira', 'series.json'), mylar('Akira, the whole of it'), 5)
    const summary = await scanLibrary(database.db, 'L1')

    // Nothing about the books or the folder moved, and the series was read all the same.
    expect(summary).toMatchObject({ booksCreated: 0, booksUpdated: 0, seriesCreated: 0 })
    expect(await database.db.selectFrom('series_metadata').select('title').execute()).toEqual([
      { title: 'Akira, the whole of it' },
    ])
  })

  it('takes a series’ cover that was replaced where it lies, without reading its books', async () => {
    const { database, root } = await setup()
    writeFileSync(join(root, 'Akira', 'cover.png'), await picture(4))
    await scanLibrary(database.db, 'L1')
    const [first] = await posters(database, 'SERIES')
    expect(first).toMatchObject({ width: 4, selected: 1 })
    const read = await database.db.selectFrom('series_metadata').select('last_modified_date').execute()

    writeInPlace(join(root, 'Akira', 'cover.png'), await picture(9), 5)
    await scanLibrary(database.db, 'L1')

    const [second, ...rest] = await posters(database, 'SERIES')
    expect(rest).toEqual([])
    expect(second).toMatchObject({ width: 9, selected: 1 })
    expect(await database.db.selectFrom('series_metadata').select('last_modified_date').execute()).toEqual(read)
  })

  it('asks for the artwork of an analysed book when a cover is put beside it', async () => {
    const { database, root } = await setup()
    await scanLibrary(database.db, 'L1')
    const books = await database.db.selectFrom('books').select(['id', 'name']).orderBy('name').execute()
    // Only the first book has been analysed; the second will look for its cover when it is.
    expect((await analyzeBook(database.db, books[0]!.id, join(root, 'Akira', 'Volume 1.cbz'))).status).toBe('READY')
    await database.db.deleteFrom('jobs').execute()

    writeFileSync(join(root, 'Akira', 'Volume 1.png'), await picture(4))
    writeFileSync(join(root, 'Akira', 'Volume 2.png'), await picture(4))
    await scanLibrary(database.db, 'L1')

    const jobs = await database.db.selectFrom('jobs').select(['type', 'payload']).execute()
    expect(jobs.map((job) => [job.type, JSON.parse(job.payload)])).toEqual([
      ['RefreshBookLocalArtwork', { bookId: books[0]!.id }],
    ])
    expect(await sidecars(database)).toEqual([
      ['Volume 1.png', 'BOOK', 'ARTWORK'],
      ['Volume 2.png', 'BOOK', 'ARTWORK'],
    ])
  })

  it('lets go of a cover that was removed', async () => {
    const { database, root } = await setup()
    writeFileSync(join(root, 'Akira', 'cover.png'), await picture(4))
    await scanLibrary(database.db, 'L1')
    expect(await posters(database, 'SERIES')).toHaveLength(1)

    // Removed, with the folder's date put back: only the record of the file says it was there.
    const before = statSync(join(root, 'Akira'))
    rmSync(join(root, 'Akira', 'cover.png'))
    utimesSync(join(root, 'Akira'), before.atime, before.mtime)
    await scanLibrary(database.db, 'L1')

    expect(await posters(database, 'SERIES')).toEqual([])
    expect(await sidecars(database)).toEqual([])
  })

  it('does nothing at all when nothing changed', async () => {
    const { database, root } = await setup()
    writeFileSync(join(root, 'Akira', 'cover.png'), await picture(4))
    writeFileSync(join(root, 'Akira', 'series.json'), mylar('Akira'))
    writeFileSync(join(root, 'Akira', 'Volume 1.png'), await picture(4))
    await scanLibrary(database.db, 'L1')
    await database.db.deleteFrom('jobs').execute()
    const before = {
      posters: await posters(database, 'SERIES'),
      series: await database.db.selectFrom('series_metadata').select('last_modified_date').execute(),
      sidecars: await database.db.selectFrom('sidecars').selectAll().orderBy('url').execute(),
    }

    await scanLibrary(database.db, 'L1')

    expect(await queued(database)).toEqual([])
    expect({
      posters: await posters(database, 'SERIES'),
      series: await database.db.selectFrom('series_metadata').select('last_modified_date').execute(),
      sidecars: await database.db.selectFrom('sidecars').selectAll().orderBy('url').execute(),
    }).toEqual(before)
  })
})
