import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { SETTING_KEYS, setSetting } from '../settings.js'
import { minimalPdf } from '../spikes/minimalPdf.js'
import { epubBuffer } from '../testing/epub.js'
import { writeZip } from '../testing/zip.js'
import { booksNeedingThumbnail, chosenThumbnail, generateBookThumbnail, thumbnailMaxEdge } from './generate.js'

/** A page image of a stated size. */
async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
}

/** The colour of a point in an image, as sharp decodes it. */
async function pixelAt(image: Buffer, left: number, top: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  const offset = (top * info.width + left) * info.channels
  return { r: data[offset] ?? 0, g: data[offset + 1] ?? 1, b: data[offset + 2] ?? 2 }
}

/**
 * A library holding real files, with one book per file given.
 *
 * The books are named `B1`, `B2`... in the order the files are listed, each in its
 * own series - which is enough to tell "a book with pages" from "a book without".
 */
async function library(
  files: { name: string; data: Buffer }[],
): Promise<{ database: Database; root: string; bookIds: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-thumbs-root-'))
  for (const file of files) writeFileSync(join(root, file.name), file.data)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: now, last_modified_date: now })
    .execute()

  const bookIds: string[] = []
  for (const [index, file] of files.entries()) {
    const number = index + 1
    const bookId = `B${number}`
    bookIds.push(bookId)
    await db
      .insertInto('series')
      .values({
        id: `S${number}`,
        library_id: 'L1',
        name: `Series ${number}`,
        url: `series-${number}`,
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await db
      .insertInto('books')
      .values({
        id: bookId,
        series_id: `S${number}`,
        library_id: 'L1',
        name: `Volume ${number}`,
        url: file.name,
        file_last_modified: now,
        file_size: file.data.length,
        number,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
  }

  return { database, root, bookIds }
}

/** The generated thumbnails stored for a book. */
async function storedThumbnails(database: Database, bookId: string) {
  return database.db
    .selectFrom('thumbnails')
    .selectAll()
    .where('owner_type', '=', 'BOOK')
    .where('owner_id', '=', bookId)
    .orderBy('id')
    .execute()
}

describe('a book poster', () => {
  it('is the first page of the book, converted to JPEG', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.png', data: await jpeg(600, 900) }]) },
    ])

    const generated = await generateBookThumbnail(database.db, bookIds[0]!)
    expect(generated?.width).toBe(200)
    expect(generated?.height).toBe(300)
    expect(generated?.mediaType).toBe('image/jpeg')

    const rows = await storedThumbnails(database, bookIds[0]!)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('GENERATED')
    expect(rows[0]!.selected).toBe(1)
    expect(rows[0]!.page).toBe(1)
    expect(rows[0]!.width).toBe(200)
    expect(rows[0]!.height).toBe(300)
    expect(rows[0]!.file_size).toBe(rows[0]!.thumbnail.length)
    expect((await sharp(rows[0]!.thumbnail).metadata()).format).toBe('jpeg')

    await database.close()
  })

  it('is made at the size the server is set to', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(1200, 1800) }]) },
    ])

    // Setting first, then generating: the size is read when a poster is made.
    await setSetting(database.db, SETTING_KEYS.thumbnailSize, 'LARGE')

    expect(await thumbnailMaxEdge(database.db)).toBe(900)
    const generated = await generateBookThumbnail(database.db, bookIds[0]!)
    expect(generated?.width).toBe(600)
    expect(generated?.height).toBe(900)

    await database.close()
  })

  it('takes an EPUB cover rather than a page of text', async () => {
    const cover = await jpeg(600, 900)
    const { database, bookIds } = await library([
      {
        name: 'story.epub',
        data: epubBuffer(
          '<dc:title>Story</dc:title><meta name="cover" content="cover-image"/>',
          {},
          {
            manifest: ',<item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>',
            entries: [{ name: 'OEBPS/cover.jpg', data: cover }],
          },
        ),
      },
    ])

    const generated = await generateBookThumbnail(database.db, bookIds[0]!)
    expect(generated?.width).toBe(200)
    expect(generated?.height).toBe(300)

    // The cover's own colour, not the black a text page would give.
    const pixel = await pixelAt(generated!.bytes, 10, 10)
    expect(Math.abs(pixel.r - 10)).toBeLessThanOrEqual(16)
    expect(Math.abs(pixel.b - 30)).toBeLessThanOrEqual(16)

    await database.close()
  })

  it('is the first page of a PDF', async () => {
    const { database, bookIds } = await library([{ name: 'story.pdf', data: minimalPdf() }])

    const generated = await generateBookThumbnail(database.db, bookIds[0]!)
    expect(generated).not.toBeNull()
    expect(generated?.mediaType).toBe('image/jpeg')

    await database.close()
  })

  it('is only ever one row, and leaves a chosen poster alone', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])
    const now = new Date().toISOString()
    await database.db
      .insertInto('thumbnails')
      .values({
        id: 'UPLOAD',
        owner_type: 'BOOK',
        owner_id: bookIds[0]!,
        type: 'USER' as const,
        page: 0,
        selected: 1,
        media_type: 'image/png',
        width: 4,
        height: 6,
        file_size: 10,
        thumbnail: await jpeg(4, 6),
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    await generateBookThumbnail(database.db, bookIds[0]!)
    await generateBookThumbnail(database.db, bookIds[0]!)

    const rows = await storedThumbnails(database, bookIds[0]!)
    expect(rows.filter((row) => row.type === 'GENERATED')).toHaveLength(1)
    // The upload stays the poster: a generated one never displaces a choice.
    expect(rows.find((row) => row.id === 'UPLOAD')!.selected).toBe(1)
    expect(rows.find((row) => row.type === 'GENERATED')!.selected).toBe(0)
    expect((await chosenThumbnail(database.db, 'BOOK', bookIds[0]!))!.id).toBe('UPLOAD')

    await database.close()
  })

  it('makes the generated poster the chosen one when nothing else is', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])

    const now = new Date().toISOString()
    await database.db
      .insertInto('thumbnails')
      .values({
        id: 'OLD',
        owner_type: 'BOOK',
        owner_id: bookIds[0]!,
        type: 'GENERATED',
        page: 1,
        selected: 1,
        media_type: 'image/jpeg',
        width: 100,
        height: 150,
        file_size: 10,
        thumbnail: await jpeg(100, 150),
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    await generateBookThumbnail(database.db, bookIds[0]!)
    expect((await chosenThumbnail(database.db, 'BOOK', bookIds[0]!))!.id).not.toBe('OLD')

    await database.close()
  })

  it('has nothing to make a poster from when the file is gone or unreadable', async () => {
    const { database, bookIds } = await library([{ name: 'notes.txt', data: Buffer.from('not a book') }])

    expect(await generateBookThumbnail(database.db, bookIds[0]!)).toBeNull()
    expect(await storedThumbnails(database, bookIds[0]!)).toHaveLength(0)

    // A book whose row is gone is not an error either.
    expect(await generateBookThumbnail(database.db, 'NOPE')).toBeNull()

    await database.close()
  })
})

describe('finding books that want a poster', () => {
  it('offers every book when asked for all of them', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
      { name: 'v2.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])

    await generateBookThumbnail(database.db, bookIds[0]!)
    expect(await booksNeedingThumbnail(database.db, { forBiggerResultOnly: false })).toEqual(bookIds)

    await database.close()
  })

  it('offers only the books whose poster is smaller than the size in force', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
      { name: 'v2.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])

    await generateBookThumbnail(database.db, bookIds[0]!)
    // B1's poster is the size asked for, so only B2 - which has none at all -
    // wants one.
    expect(await booksNeedingThumbnail(database.db, { forBiggerResultOnly: true })).toEqual([bookIds[1]])

    // Raising the size makes the first book's poster too small, while the second
    // book has one made at the new size.
    await setSetting(database.db, SETTING_KEYS.thumbnailSize, 'MEDIUM')
    await generateBookThumbnail(database.db, bookIds[1]!)

    expect(await booksNeedingThumbnail(database.db, { forBiggerResultOnly: true })).toEqual([bookIds[0]])

    await database.close()
  })

  it('scopes to a library when one is named', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])

    expect(await booksNeedingThumbnail(database.db, { libraryId: 'L1' })).toEqual(bookIds)
    expect(await booksNeedingThumbnail(database.db, { libraryId: 'NOPE' })).toEqual([])

    await database.close()
  })

  it('ignores books that were deleted', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])

    await database.db
      .updateTable('books')
      .set({ deleted_date: new Date().toISOString() })
      .where('id', '=', bookIds[0]!)
      .execute()

    expect(await booksNeedingThumbnail(database.db, {})).toEqual([])

    await database.close()
  })
})

describe('choosing a poster', () => {
  it('prefers the selected row, then the newest', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: writeZip([{ name: '1.jpg', data: await jpeg(600, 900) }]) },
    ])
    const bookId = bookIds[0]!
    const image = await jpeg(4, 6)

    const row = (id: string, selected: number, created: string) => ({
      id,
      owner_type: 'BOOK' as const,
      owner_id: bookId,
      type: 'USER' as const,
      page: 0,
      selected,
      media_type: 'image/jpeg',
      width: 4,
      height: 6,
      file_size: image.length,
      thumbnail: image,
      created_date: created,
      last_modified_date: created,
    })

    await database.db
      .insertInto('thumbnails')
      .values([
        row('OLD', 0, '2023-01-01T00:00:00.000Z'),
        row('NEW', 0, '2024-01-01T00:00:00.000Z'),
        row('CHOSEN', 1, '2022-01-01T00:00:00.000Z'),
      ])
      .execute()

    expect((await chosenThumbnail(database.db, 'BOOK', bookId))!.id).toBe('CHOSEN')
    await database.db.updateTable('thumbnails').set({ selected: 0 }).where('id', '=', 'CHOSEN').execute()
    expect((await chosenThumbnail(database.db, 'BOOK', bookId))!.id).toBe('NEW')

    expect(await chosenThumbnail(database.db, 'BOOK', 'NOPE')).toBeNull()

    await database.close()
  })
})
