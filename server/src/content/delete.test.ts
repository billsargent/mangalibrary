import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { refreshBookLocalArtwork, refreshSeriesLocalArtwork } from '../metadata/localArtwork.js'
import { scanLibrary } from '../scan/reconcile.js'
import { writeZip } from '../testing/zip.js'
import { deleteBookFiles, deleteSeriesFiles } from './delete.js'

const book = (label: string): Buffer => writeZip([{ name: '1.jpg', data: Buffer.from(`a page of ${label}`) }])
const picture = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#224466' } })
  .png()
  .toBuffer()

const log = () => {
  const said: string[] = []
  return {
    said,
    info: (_context: Record<string, unknown>, message: string) => void said.push(message),
    warn: (_context: Record<string, unknown>, message: string) => void said.push(message),
  }
}

/** A library with Akira (two volumes), Berserk (one) and a oneshot. */
async function setup(extra?: (root: string) => void): Promise<{ database: Database; root: string }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-delete-')))
  mkdirSync(join(root, 'Akira'))
  writeFileSync(join(root, 'Akira', 'Volume 1.cbz'), book('akira 1'))
  writeFileSync(join(root, 'Akira', 'Volume 2.cbz'), book('akira 2'))
  mkdirSync(join(root, 'Berserk'))
  writeFileSync(join(root, 'Berserk', 'Volume 1.cbz'), book('berserk'))
  mkdirSync(join(root, '_oneshots'))
  writeFileSync(join(root, '_oneshots', 'Solo.cbz'), book('solo'))
  extra?.(root)

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
  return { database, root }
}

const seriesNamed = async (database: Database, name: string) =>
  (await database.db.selectFrom('series').selectAll().where('name', '=', name).executeTakeFirstOrThrow()) as {
    id: string
    deleted_date: string | null
    book_count: number
  }
const booksOf = (database: Database, seriesId: string) =>
  database.db
    .selectFrom('books')
    .select(['id', 'name', 'number', 'deleted_date'])
    .where('series_id', '=', seriesId)
    .orderBy('name')
    .execute()
const history = async (database: Database) =>
  (await database.db.selectFrom('historical_events').selectAll().orderBy('id').execute()).map((event) => [
    event.type,
    event.book_id,
    event.series_id,
    JSON.parse(event.properties) as Record<string, string>,
  ])

describe('deleting a book’s file', () => {
  it('removes the file, records it, and leaves the folder that still holds a book', async () => {
    const { database, root } = await setup()
    const akira = await seriesNamed(database, 'Akira')
    const [first, second] = await booksOf(database, akira.id)

    const deleted = await deleteBookFiles(database.db, log(), first!.id)

    expect(deleted).toEqual({ bookIds: [first!.id], seriesId: null })
    expect(readdirSync(join(root, 'Akira'))).toEqual(['Volume 2.cbz'])
    expect(await history(database)).toEqual([
      [
        'BOOK_FILE_DELETED',
        first!.id,
        akira.id,
        { reason: 'File was deleted by user request', name: join(root, 'Akira', 'Volume 1.cbz') },
      ],
    ])
    // The book is in the trash, and the one that is left is now the first.
    const after = await booksOf(database, akira.id)
    expect(after[0]!.deleted_date).not.toBeNull()
    expect(after[1]).toMatchObject({ id: second!.id, number: 1, deleted_date: null })
    expect((await seriesNamed(database, 'Akira')).book_count).toBe(1)
  })

  it('takes the folder too when the book was the last thing in it, and its artwork with it', async () => {
    const { database, root } = await setup((library) =>
      writeFileSync(join(library, 'Berserk', 'Volume 1.png'), picture),
    )
    const berserk = await seriesNamed(database, 'Berserk')
    const [only] = await booksOf(database, berserk.id)
    expect(await refreshBookLocalArtwork(database.db, only!.id)).toBe(1)

    const deleted = await deleteBookFiles(database.db, log(), only!.id)

    expect(existsSync(join(root, 'Berserk'))).toBe(false)
    // Nothing is left of the series, so it goes to the trash with its last book.
    expect(deleted).toEqual({ bookIds: [only!.id], seriesId: berserk.id })
    expect((await seriesNamed(database, 'Berserk')).deleted_date).not.toBeNull()
    expect((await history(database)).map((event) => [event[0], event[3]])).toEqual([
      [
        'BOOK_FILE_DELETED',
        { reason: 'File was deleted by user request', name: join(root, 'Berserk', 'Volume 1.cbz') },
      ],
      ['SERIES_FOLDER_DELETED', { reason: 'Folder was deleted because it was empty', name: join(root, 'Berserk') }],
    ])
    // The other series were not touched.
    expect(readdirSync(root).sort()).toEqual(['Akira', '_oneshots'])
  })

  it('leaves a folder that holds anything else', async () => {
    const { database, root } = await setup((library) => writeFileSync(join(library, 'Berserk', 'notes.txt'), 'mine'))
    const [only] = await booksOf(database, (await seriesNamed(database, 'Berserk')).id)

    await deleteBookFiles(database.db, log(), only!.id)

    expect(readdirSync(join(root, 'Berserk'))).toEqual(['notes.txt'])
    // The folder is still there, so the series is too.
    expect((await seriesNamed(database, 'Berserk')).deleted_date).toBeNull()
    expect((await history(database)).map((event) => event[0])).toEqual(['BOOK_FILE_DELETED'])
  })

  it('deletes the series when the book is a oneshot', async () => {
    const { database, root } = await setup()
    const solo = await seriesNamed(database, 'Solo')
    const [only] = await booksOf(database, solo.id)

    const deleted = await deleteBookFiles(database.db, log(), only!.id)

    expect(deleted).toEqual({ bookIds: [only!.id], seriesId: solo.id })
    expect(existsSync(join(root, '_oneshots', 'Solo.cbz'))).toBe(false)
    expect((await seriesNamed(database, 'Solo')).deleted_date).not.toBeNull()
    // The next scan agrees with what was done.
    expect(await scanLibrary(database.db, 'L1')).toMatchObject({ seriesDeleted: 0, booksDeleted: 0, booksCreated: 0 })
  })

  it('never removes the library’s own folder, however empty', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-delete-root-')))
    writeFileSync(join(root, 'Loose.cbz'), book('loose'))
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    await database.db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'Main', root, created_date: 'now', last_modified_date: 'now' } as never)
      .execute()
    await scanLibrary(database.db, 'L1')
    const loose = await database.db.selectFrom('books').select(['id', 'series_id']).executeTakeFirstOrThrow()

    await deleteSeriesFiles(database.db, log(), loose.series_id)

    expect(existsSync(join(root, 'Loose.cbz'))).toBe(false)
    expect(existsSync(root)).toBe(true)
    expect((await history(database)).map((event) => event[0])).toEqual(['BOOK_FILE_DELETED'])
  })

  it('does nothing, and says so, when the file is not there', async () => {
    const { database, root } = await setup()
    const akira = await seriesNamed(database, 'Akira')
    const [first] = await booksOf(database, akira.id)
    const { rmSync } = await import('node:fs')
    rmSync(join(root, 'Akira', 'Volume 1.cbz'))
    const said = log()

    expect(await deleteBookFiles(database.db, said, first!.id)).toEqual({ bookIds: [], seriesId: null })

    expect(said.said).toEqual(['cannot delete book file, path does not exist'])
    expect((await booksOf(database, akira.id))[0]!.deleted_date).toBeNull()
    expect(await history(database)).toEqual([])
  })

  it('does nothing, and says so, when the file cannot be written', async () => {
    const { database, root } = await setup()
    const akira = await seriesNamed(database, 'Akira')
    const [first] = await booksOf(database, akira.id)
    const file = join(root, 'Akira', 'Volume 1.cbz')
    chmodSync(file, 0o444)
    const said = log()
    try {
      expect(await deleteBookFiles(database.db, said, first!.id)).toEqual({ bookIds: [], seriesId: null })
      expect(said.said).toEqual(['cannot delete book file, path is not writable'])
      expect(existsSync(file)).toBe(true)
      expect((await booksOf(database, akira.id))[0]!.deleted_date).toBeNull()
    } finally {
      chmodSync(file, 0o666)
    }
  })
})

describe('deleting a series’ files', () => {
  it('removes every book, the series’ own artwork, and then the folder', async () => {
    const { database, root } = await setup((library) => writeFileSync(join(library, 'Akira', 'cover.png'), picture))
    const akira = await seriesNamed(database, 'Akira')
    expect(await refreshSeriesLocalArtwork(database.db, akira.id)).toBe(1)
    const ids = (await booksOf(database, akira.id)).map((row) => row.id)

    const deleted = await deleteSeriesFiles(database.db, log(), akira.id)

    expect(deleted).toEqual({ bookIds: ids, seriesId: akira.id })
    expect(existsSync(join(root, 'Akira'))).toBe(false)
    expect((await history(database)).map((event) => [event[0], event[2]])).toEqual([
      ['BOOK_FILE_DELETED', akira.id],
      ['BOOK_FILE_DELETED', akira.id],
      ['SERIES_FOLDER_DELETED', akira.id],
    ])
    expect(await seriesNamed(database, 'Akira')).toMatchObject({ book_count: 0 })
    expect((await seriesNamed(database, 'Akira')).deleted_date).not.toBeNull()
    expect((await booksOf(database, akira.id)).every((row) => row.deleted_date !== null)).toBe(true)
  })

  it('keeps a folder that still holds something nobody asked to delete', async () => {
    const { database, root } = await setup((library) => writeFileSync(join(library, 'Akira', 'notes.txt'), 'mine'))
    const akira = await seriesNamed(database, 'Akira')

    await deleteSeriesFiles(database.db, log(), akira.id)

    expect(readdirSync(join(root, 'Akira'))).toEqual(['notes.txt'])
    expect((await history(database)).map((event) => event[0])).toEqual(['BOOK_FILE_DELETED', 'BOOK_FILE_DELETED'])
  })

  it('does nothing when the folder is not there', async () => {
    const { database, root } = await setup()
    const akira = await seriesNamed(database, 'Akira')
    const { rmSync } = await import('node:fs')
    rmSync(join(root, 'Akira'), { recursive: true })
    const said = log()

    expect(await deleteSeriesFiles(database.db, said, akira.id)).toEqual({ bookIds: [], seriesId: null })
    expect(said.said).toEqual(['cannot delete series folder, path does not exist'])
    expect((await seriesNamed(database, 'Akira')).deleted_date).toBeNull()
  })
})
