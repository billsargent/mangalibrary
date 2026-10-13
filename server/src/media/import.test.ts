import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { scanLibrary } from '../scan/reconcile.js'
import { writeZip } from '../testing/zip.js'
import { analyzeBook } from './analyze.js'
import { ImportError, importBook, type ImportRequest } from './import.js'

const book = (label: string): Buffer => writeZip([{ name: '1.jpg', data: Buffer.from(`a page of ${label}`) }])

interface Fixture {
  database: Database
  /** The library's folder, holding the series Akira with Volume 1, and a oneshot. */
  root: string
  /** A folder outside every library, where files to import are. */
  inbox: string
  seriesId: string
  volume1: string
}

async function setup(): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-import-library-')))
  const inbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-import-inbox-')))
  mkdirSync(join(root, 'Akira'))
  writeFileSync(join(root, 'Akira', 'Volume 1.cbz'), book('volume 1'))
  mkdirSync(join(root, 'Berserk'))
  writeFileSync(join(root, 'Berserk', 'Volume 1.cbz'), book('berserk'))
  mkdirSync(join(root, '_oneshots'))
  writeFileSync(join(root, '_oneshots', 'Solo.cbz'), book('solo'))

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
    } as never)
    .execute()
  await scanLibrary(database.db, 'L1')

  const series = await database.db.selectFrom('series').select(['id', 'name']).execute()
  const seriesId = series.find((row) => row.name === 'Akira')!.id
  const volume1 = (await database.db.selectFrom('books').select('id').where('series_id', '=', seriesId).execute())[0]!
    .id
  return { database, root, inbox, seriesId, volume1 }
}

const books = (database: Database, seriesId: string) =>
  database.db
    .selectFrom('books')
    .select(['id', 'name', 'number', 'url'])
    .where('series_id', '=', seriesId)
    .where('deleted_date', 'is', null)
    .orderBy('number')
    .execute()
const history = async (database: Database) =>
  (await database.db.selectFrom('historical_events').selectAll().orderBy('type').execute()).map((event) => [
    event.type,
    event.book_id,
    JSON.parse(event.properties) as Record<string, string>,
  ])

/** What an import is refused with: the code the web UI shows a sentence for, or the message. */
async function refusal(database: Database, request: ImportRequest): Promise<string> {
  try {
    await importBook(database.db, request)
  } catch (error) {
    if (error instanceof ImportError) return error.reported
    throw error
  }
  throw new Error('the import was not refused')
}

describe('importing a file into a series', () => {
  it('copies it in as a new book, numbered with the rest, and leaves the original', async () => {
    const { database, root, inbox, seriesId } = await setup()
    const source = join(inbox, 'Volume 2.cbz')
    writeFileSync(source, book('volume 2'))
    // Artwork beside the file is the book's, and comes with it.
    const cover = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#224466' } })
      .jpeg()
      .toBuffer()
    writeFileSync(join(inbox, 'Volume 2.jpg'), cover)

    const result = await importBook(database.db, { sourceFile: source, seriesId, copyMode: 'COPY' })
    expect(result.upgraded).toBe(false)

    const target = join(root, 'Akira', 'Volume 2.cbz')
    expect(readFileSync(target).equals(book('volume 2'))).toBe(true)
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(join(root, 'Akira', 'Volume 2.jpg')).equals(cover)).toBe(true)

    expect((await books(database, seriesId)).map((row) => [row.name, row.number])).toEqual([
      ['Volume 1', 1],
      ['Volume 2', 2],
    ])
    const added = (await books(database, seriesId))[1]!
    expect(added.id).toBe(result.bookId)
    expect(added.url).toBe(pathToFileURL(target).href)
    expect(
      (await database.db.selectFrom('series').select('book_count').where('id', '=', seriesId).execute())[0],
    ).toEqual({
      book_count: 2,
    })
    expect(await history(database)).toEqual([['BOOK_IMPORTED', result.bookId, { name: target, source, upgrade: 'No' }]])

    // The next scan finds what the import left, and changes nothing.
    expect(await scanLibrary(database.db, 'L1')).toMatchObject({ booksCreated: 0, booksDeleted: 0 })
    expect(await books(database, seriesId)).toHaveLength(2)
  })

  it('moves it when asked to, and links it when asked to', async () => {
    const { database, root, inbox, seriesId } = await setup()
    const moved = join(inbox, 'Volume 2.cbz')
    const linked = join(inbox, 'Volume 3.cbz')
    writeFileSync(moved, book('volume 2'))
    writeFileSync(linked, book('volume 3'))

    await importBook(database.db, { sourceFile: moved, seriesId, copyMode: 'MOVE' })
    expect(existsSync(moved)).toBe(false)
    expect(existsSync(join(root, 'Akira', 'Volume 2.cbz'))).toBe(true)

    await importBook(database.db, { sourceFile: linked, seriesId, copyMode: 'HARDLINK' })
    const target = join(root, 'Akira', 'Volume 3.cbz')
    expect(readFileSync(target).equals(book('volume 3'))).toBe(true)
    expect(existsSync(linked)).toBe(true)
    // One file under two names, where the disk can do that; a copy where it cannot.
    expect([1, 2]).toContain(statSync(target).nlink)
  })

  it('gives it the name asked for, inside the series folder and nowhere else', async () => {
    const { database, root, inbox, seriesId } = await setup()
    const source = join(inbox, 'scan_final_v2.cbz')
    writeFileSync(source, book('volume 2'))

    await importBook(database.db, {
      sourceFile: source,
      seriesId,
      copyMode: 'COPY',
      destinationName: '../../outside/Volume 2',
    })

    expect(readdirSync(join(root, 'Akira')).sort()).toEqual(['Volume 1.cbz', 'Volume 2.cbz'])
    expect(existsSync(join(root, '..', 'outside'))).toBe(false)
    expect((await books(database, seriesId)).map((row) => row.name)).toEqual(['Volume 1', 'Volume 2'])
  })

  it('upgrades a book: the same book, the new file, and the old file gone', async () => {
    const { database, root, inbox, seriesId, volume1 } = await setup()
    const old = join(root, 'Akira', 'Volume 1.cbz')
    expect((await analyzeBook(database.db, volume1, old)).status).toBe('READY')
    const source = join(inbox, 'Volume 1 (remastered).cbz')
    writeFileSync(source, book('a better volume 1'))

    const result = await importBook(database.db, {
      sourceFile: source,
      seriesId,
      copyMode: 'MOVE',
      upgradeBookId: volume1,
    })

    // The book is the one it was, so whatever hangs off its id is still there.
    expect(result).toEqual({ bookId: volume1, upgraded: true })
    const target = join(root, 'Akira', 'Volume 1 (remastered).cbz')
    expect(readdirSync(join(root, 'Akira'))).toEqual(['Volume 1 (remastered).cbz'])
    expect(await books(database, seriesId)).toEqual([
      { id: volume1, name: 'Volume 1 (remastered)', number: 1, url: pathToFileURL(target).href },
    ])
    // What analysis said was about the old file.
    const media = await database.db.selectFrom('media').select('status').where('book_id', '=', volume1).execute()
    expect(media).toEqual([{ status: 'OUTDATED' }])
    expect(await history(database)).toEqual([
      ['BOOK_FILE_DELETED', volume1, { name: old, reason: 'File was deleted to import an upgrade' }],
      ['BOOK_IMPORTED', volume1, { name: target, source, upgrade: 'Yes' }],
    ])
  })

  it('upgrades in place when the new file has the old one’s name', async () => {
    const { database, root, inbox, seriesId, volume1 } = await setup()
    const source = join(inbox, 'Volume 1.cbz')
    writeFileSync(source, book('a better volume 1'))

    await importBook(database.db, { sourceFile: source, seriesId, copyMode: 'COPY', upgradeBookId: volume1 })

    const target = join(root, 'Akira', 'Volume 1.cbz')
    expect(readFileSync(target).equals(book('a better volume 1'))).toBe(true)
    expect((await books(database, seriesId)).map((row) => row.id)).toEqual([volume1])
  })

  it('upgrades a oneshot, and the series follows its file', async () => {
    const { database, root, inbox } = await setup()
    const solo = (await database.db.selectFrom('series').select(['id']).where('oneshot', '=', 1).execute())[0]!
    const soloBook = (await books(database, solo.id))[0]!
    const source = join(inbox, 'Solo (deluxe).cbz')
    writeFileSync(source, book('solo, deluxe'))

    // A oneshot is one book; another cannot be added to it.
    expect(await refusal(database, { sourceFile: source, seriesId: solo.id, copyMode: 'COPY' })).toContain('oneshot')

    await importBook(database.db, {
      sourceFile: source,
      seriesId: solo.id,
      copyMode: 'COPY',
      upgradeBookId: soloBook.id,
    })
    expect(readdirSync(join(root, '_oneshots'))).toEqual(['Solo (deluxe).cbz'])
    // A scan knows a oneshot by its file, and must not take this for a new one.
    expect(await scanLibrary(database.db, 'L1')).toMatchObject({ seriesCreated: 0, seriesDeleted: 0, booksCreated: 0 })
  })

  it('refuses what the reference refuses, and changes nothing when it does', async () => {
    const { database, root, inbox, seriesId } = await setup()
    const source = join(inbox, 'Volume 2.cbz')
    writeFileSync(source, book('volume 2'))
    const request = { sourceFile: source, seriesId, copyMode: 'COPY' } as const
    const berserk = (await database.db.selectFrom('books').select('id').where('name', '=', 'Volume 1').execute()).find(
      (row) => row.id !== undefined,
    )

    expect(await refusal(database, { ...request, sourceFile: join(inbox, 'missing.cbz') })).toBe('ERR_1018')
    // A file that is in a library is a book already.
    expect(await refusal(database, { ...request, sourceFile: join(root, 'Berserk', 'Volume 1.cbz') })).toBe('ERR_1019')
    // A book of another series is not this series' to replace.
    const other = (await database.db.selectFrom('books').select(['id', 'series_id']).execute()).find(
      (row) => row.series_id !== seriesId,
    )!
    expect(await refusal(database, { ...request, upgradeBookId: other.id })).toBe('ERR_1020')
    // A file of that name is there, and it is not the one being replaced.
    expect(await refusal(database, { ...request, destinationName: 'Volume 1' })).toBe('ERR_1021')
    writeFileSync(join(inbox, 'notes.txt'), 'not a book')
    expect(await refusal(database, { ...request, sourceFile: join(inbox, 'notes.txt') })).toBe('ERR_1022')
    expect(await refusal(database, { ...request, seriesId: 'NOPE' })).toContain('Series does not exist')

    expect(berserk).toBeDefined()
    expect(readdirSync(join(root, 'Akira'))).toEqual(['Volume 1.cbz'])
    expect(await books(database, seriesId)).toHaveLength(1)
    expect(await history(database)).toEqual([])
    expect(existsSync(source)).toBe(true)
  })
})
