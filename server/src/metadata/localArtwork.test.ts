import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { bookArtwork, refreshBookLocalArtwork, refreshSeriesLocalArtwork, seriesArtwork } from './localArtwork.js'

/** A real PNG of a stated size. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer()
}

/** A real JPEG of a stated size. */
async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

/**
 * A library with one series folder holding one book, and a second series that holds
 * nothing - so a test can put a cover beside the book, in the series' folder, or
 * both, and see which one is picked up.
 */
async function setup(
  options: { importLocalArtwork?: number; oneshot?: number } = {},
): Promise<{ database: Database; root: string; series: string; book: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-artwork-root-'))
  const series = join(root, 'Akira')
  mkdirSync(series, { recursive: true })
  const book = join(series, 'Volume 1.cbz')
  writeFileSync(book, Buffer.from('not a real archive'))

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      import_local_artwork: options.importLocalArtwork ?? 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Akira',
      url: 'Akira',
      oneshot: options.oneshot ?? 0,
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'Akira/Volume 1.cbz',
      file_last_modified: now,
      file_size: 20,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  return { database, root, series, book }
}

/** The artwork rows stored for an owner. */
async function artworkRows(database: Database, ownerType: 'BOOK' | 'SERIES', ownerId: string) {
  return database.db
    .selectFrom('thumbnails')
    .selectAll()
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .orderBy('url')
    .execute()
}

describe('artwork beside a book', () => {
  it('is found by the book\u2019s own name, ignoring case and a numbered suffix', async () => {
    const { database, series, book } = await setup()
    writeFileSync(join(series, 'Volume 1.png'), await png(40, 60))
    writeFileSync(join(series, 'volume 1-1.JPG'), await jpeg(50, 80))
    writeFileSync(join(series, 'Volume 1-2.jpg'), await jpeg(60, 90))

    const found = await bookArtwork(book)
    // Sorted by name, ignoring case, which decides which one is selected.
    expect(found.map((file) => file.path.split(/[\\/]/).pop())).toEqual([
      'volume 1-1.JPG',
      'Volume 1-2.jpg',
      'Volume 1.png',
    ])
    expect(found[0]!.width).toBe(50)
    expect(found[0]!.height).toBe(80)

    expect(await refreshBookLocalArtwork(database.db, 'B1')).toBe(3)

    const rows = await artworkRows(database, 'BOOK', 'B1')
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.type === 'SIDECAR')).toBe(true)
    // The file is not copied into the database: the row says where it is.
    expect(rows.every((row) => row.thumbnail === null)).toBe(true)
    expect(rows.every((row) => row.url !== null)).toBe(true)
    expect(rows.filter((row) => row.selected === 1)).toHaveLength(1)
    expect(rows.find((row) => row.selected === 1)!.url).toMatch(/volume 1-1\.JPG$/i)
    expect(rows.every((row) => row.file_size > 0)).toBe(true)
    // The type comes from the file's content, not the name it happens to have.
    expect(rows.find((row) => row.url?.endsWith('.png'))!.media_type).toBe('image/png')
    expect(rows.find((row) => row.url?.endsWith('.jpg'))!.media_type).toBe('image/jpeg')

    await database.close()
  })

  it('ignores a file that is not an image, and one named after a different book', async () => {
    const { database, series, book } = await setup()
    writeFileSync(join(series, 'Volume 2.png'), await png(40, 60))
    writeFileSync(join(series, 'Volume 1.png'), Buffer.from('not an image at all'))
    writeFileSync(join(series, 'Volume 1.txt'), Buffer.from('a note beside the book'))

    expect(await bookArtwork(book)).toEqual([])
    expect(await refreshBookLocalArtwork(database.db, 'B1')).toBe(0)
    expect(await artworkRows(database, 'BOOK', 'B1')).toHaveLength(0)

    await database.close()
  })

  it('says what a cover is by its content, not by its name', async () => {
    const { database, series } = await setup()
    // A PNG called `.jpg`, and a `.tbn`, which is a thumbnail of some other format.
    writeFileSync(join(series, 'Volume 1.jpg'), await png(40, 60))
    writeFileSync(join(series, 'Volume 1-1.tbn'), await jpeg(30, 45))

    await refreshBookLocalArtwork(database.db, 'B1')

    const rows = await artworkRows(database, 'BOOK', 'B1')
    expect(rows.find((row) => row.url?.endsWith('.jpg'))!.media_type).toBe('image/png')
    expect(rows.find((row) => row.url?.endsWith('.tbn'))!.media_type).toBe('image/jpeg')

    await database.close()
  })

  it('is not looked for when the library is set not to import it', async () => {
    const { database, series, book } = await setup({ importLocalArtwork: 0 })
    writeFileSync(join(series, 'Volume 1.png'), await png(40, 60))

    expect(await bookArtwork(book)).toHaveLength(1)
    expect(await refreshBookLocalArtwork(database.db, 'B1')).toBe(0)
    expect(await artworkRows(database, 'BOOK', 'B1')).toHaveLength(0)

    await database.close()
  })

  it('drops the row for a cover that has been taken away', async () => {
    const { database, series, book } = await setup()
    const cover = join(series, 'Volume 1.png')
    writeFileSync(cover, await png(40, 60))
    await refreshBookLocalArtwork(database.db, 'B1')
    expect(await artworkRows(database, 'BOOK', 'B1')).toHaveLength(1)

    rmSync(cover)
    expect(await refreshBookLocalArtwork(database.db, 'B1')).toBe(0)
    // And the same for a cover that was renamed out of the way.
    expect(await artworkRows(database, 'BOOK', 'B1')).toHaveLength(0)
    expect(await bookArtwork(book)).toEqual([])

    await database.close()
  })

  it('replaces its row when the cover changes, which the row\u2019s date shows', async () => {
    const { database, series } = await setup()
    const cover = join(series, 'Volume 1.png')
    writeFileSync(cover, await png(40, 60))
    await refreshBookLocalArtwork(database.db, 'B1')
    const before = (await artworkRows(database, 'BOOK', 'B1'))[0]!

    writeFileSync(cover, await png(120, 180))
    await refreshBookLocalArtwork(database.db, 'B1')

    const after = (await artworkRows(database, 'BOOK', 'B1'))[0]!
    expect(after.width).toBe(120)
    expect(after.height).toBe(180)
    expect(after.id).not.toBe(before.id)

    await database.close()
  })

  it('is chosen over a poster this server generated', async () => {
    const { database, series } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('thumbnails')
      .values({
        id: 'GENERATED',
        owner_type: 'BOOK',
        owner_id: 'B1',
        type: 'GENERATED',
        page: 1,
        selected: 1,
        media_type: 'image/jpeg',
        width: 200,
        height: 300,
        file_size: 10,
        thumbnail: await sharp({ create: { width: 4, height: 6, channels: 3, background: '#000' } })
          .jpeg()
          .toBuffer(),
        url: null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    writeFileSync(join(series, 'Volume 1.png'), await png(40, 60))
    await refreshBookLocalArtwork(database.db, 'B1')

    const rows = await artworkRows(database, 'BOOK', 'B1')
    const generated = rows.find((row) => row.id === 'GENERATED')!
    const sidecar = rows.find((row) => row.type === 'SIDECAR')!
    expect(sidecar.selected).toBe(1)
    // Only one row is ever selected.
    expect(generated.selected).toBe(0)
    expect(rows.filter((row) => row.selected === 1)).toHaveLength(1)

    await database.close()
  })

  it('does not displace a poster the user uploaded', async () => {
    const { database, series } = await setup()
    const now = new Date().toISOString()
    await database.db
      .insertInto('thumbnails')
      .values({
        id: 'UPLOAD',
        owner_type: 'BOOK',
        owner_id: 'B1',
        type: 'USER',
        page: 0,
        selected: 1,
        media_type: 'image/png',
        width: 4,
        height: 6,
        file_size: 10,
        thumbnail: await png(4, 6),
        url: null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    writeFileSync(join(series, 'Volume 1.png'), await png(40, 60))
    await refreshBookLocalArtwork(database.db, 'B1')

    const rows = await artworkRows(database, 'BOOK', 'B1')
    expect(rows.find((row) => row.id === 'UPLOAD')!.selected).toBe(1)
    expect(rows.find((row) => row.type === 'SIDECAR')!.selected).toBe(0)

    await database.close()
  })
})

describe('artwork in a series folder', () => {
  it('is found by the names a cover is given', async () => {
    const { database, series } = await setup()
    writeFileSync(join(series, 'cover.png'), await png(40, 60))
    writeFileSync(join(series, 'poster.jpg'), await png(50, 80))

    const found = await seriesArtwork(series, { oneshot: false })
    expect(found.map((file) => file.path.split(/[\\/]/).pop())).toEqual(['cover.png', 'poster.jpg'])

    expect(await refreshSeriesLocalArtwork(database.db, 'S1')).toBe(2)
    const rows = await artworkRows(database, 'SERIES', 'S1')
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.url?.endsWith('cover.png'))!.selected).toBe(1)

    await database.close()
  })

  it('accepts every name the reference accepts', async () => {
    const { database, series } = await setup()
    for (const name of ['default.png', 'folder.png', 'series.png', 'COVER.JPEG', 'cover.tbn', 'cover.webp']) {
      writeFileSync(join(series, name), await png(20, 30))
    }

    expect(await refreshSeriesLocalArtwork(database.db, 'S1')).toBe(6)
    await database.close()
  })

  it('is not looked for on a oneshot series, whose folder is the library root', async () => {
    const { database, series } = await setup({ oneshot: 1 })
    writeFileSync(join(series, 'cover.png'), await png(40, 60))

    expect(await seriesArtwork(series, { oneshot: true })).toEqual([])
    expect(await refreshSeriesLocalArtwork(database.db, 'S1')).toBe(0)
    expect(await artworkRows(database, 'SERIES', 'S1')).toHaveLength(0)

    await database.close()
  })

  it('says nothing about an owner that is not there', async () => {
    const { database } = await setup()
    expect(await refreshBookLocalArtwork(database.db, 'NOPE')).toBe(0)
    expect(await refreshSeriesLocalArtwork(database.db, 'NOPE')).toBe(0)
    await database.close()
  })
})
