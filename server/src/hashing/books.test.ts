import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { analyzeBook } from '../media/analyze.js'
import { minimalPdf } from '../spikes/minimalPdf.js'
import { epubBuffer } from '../testing/epub.js'
import { writeZip } from '../testing/zip.js'
import {
  booksNeedingFileHash,
  booksNeedingKoreaderHash,
  booksNeedingPageHash,
  hashBookFile,
  hashBookKoreader,
  hashBookPages,
} from './books.js'
import { fileHash, koreaderHash, pageHash } from './hashes.js'

/** A page image of one page, distinct from its neighbours. */
async function page(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 90, channels: 3, background: { r: seed, g: seed * 2, b: seed * 3 } } })
    .png()
    .toBuffer()
}

/** A comic archive of the pages given. */
async function comic(pageCount: number): Promise<{ data: Buffer; pages: Buffer[] }> {
  const pages: Buffer[] = []
  for (let number = 1; number <= pageCount; number += 1) pages.push(await page(number * 10))

  return {
    data: writeZip(pages.map((bytes, index) => ({ name: `${index + 1}.png`, data: bytes }))),
    pages,
  }
}

/**
 * A library holding real files, analysed, with one book per file given.
 *
 * Analysing is part of setting up because that is what a hashing job finds: a book
 * whose media rows describe its pages, queued by a scan that has already run.
 */
async function library(
  files: { name: string; data: Buffer }[],
  settings: { hashFiles?: number; hashPages?: number; hashKoreader?: number } = {},
): Promise<{ database: Database; root: string; bookIds: string[]; paths: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-hashing-root-'))
  for (const file of files) writeFileSync(join(root, file.name), file.data)

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
      created_date: now,
      last_modified_date: now,
      hash_files: settings.hashFiles ?? 1,
      hash_pages: settings.hashPages ?? 1,
      hash_koreader: settings.hashKoreader ?? 1,
    })
    .execute()

  const bookIds: string[] = []
  const paths: string[] = []
  for (const [index, file] of files.entries()) {
    const number = index + 1
    const bookId = `B${number}`
    bookIds.push(bookId)
    paths.push(join(root, file.name))

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

    await analyzeBook(db, bookId, join(root, file.name))
  }

  return { database, root, bookIds, paths }
}

/** A book's stored hashes, by page number. */
async function storedPageHashes(database: Database, bookId: string): Promise<Map<number, string>> {
  const rows = await database.db
    .selectFrom('media_page')
    .select(['number', 'file_hash'])
    .where('book_id', '=', bookId)
    .orderBy('number')
    .execute()

  return new Map(rows.map((row) => [row.number, row.file_hash]))
}

/** A book's row, for the two hashes it carries. */
async function storedBook(database: Database, bookId: string) {
  return database.db
    .selectFrom('books')
    .select(['file_hash', 'file_hash_koreader'])
    .where('id', '=', bookId)
    .executeTakeFirstOrThrow()
}

describe("a book's file hash", () => {
  it('is written when the book has none', async () => {
    const { database, bookIds, paths } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])

    expect(await hashBookFile(database.db, bookIds[0]!)).toEqual({ status: 'HASHED', hash: await fileHash(paths[0]!) })
    expect((await storedBook(database, bookIds[0]!)).file_hash).toBe(await fileHash(paths[0]!))

    await database.close()
  })

  it('is left alone when the book already has one', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])
    await hashBookFile(database.db, bookIds[0]!)

    expect(await hashBookFile(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'ALREADY_HASHED' })

    await database.close()
  })

  it('is not written when the library stopped asking for it', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }], { hashFiles: 0 })

    expect(await hashBookFile(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    expect((await storedBook(database, bookIds[0]!)).file_hash).toBeNull()

    await database.close()
  })

  it('says so when the book or its file is gone', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])

    expect(await hashBookFile(database.db, 'not-a-book')).toEqual({ status: 'SKIPPED', reason: 'GONE' })

    await database.db.deleteFrom('books').where('id', '=', bookIds[0]!).execute()
    expect(await hashBookFile(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'GONE' })

    await database.close()
  })
})

describe("a book's KOReader hash", () => {
  it('is the partial MD5 of its file, and only when the library asks for it', async () => {
    const { database, bookIds, paths } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])

    expect(await hashBookKoreader(database.db, bookIds[0]!)).toEqual({
      status: 'HASHED',
      hash: await koreaderHash(paths[0]!),
    })
    expect((await storedBook(database, bookIds[0]!)).file_hash_koreader).toBe(await koreaderHash(paths[0]!))
    expect(await hashBookKoreader(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'ALREADY_HASHED' })

    await database.close()
  })

  it('is not written when the library stopped asking for it', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }], { hashKoreader: 0 })

    expect(await hashBookKoreader(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    expect((await storedBook(database, bookIds[0]!)).file_hash_koreader).toBeNull()

    await database.close()
  })
})

describe("a book's page hashes", () => {
  it('are the first and last pages, and only those', async () => {
    const { data, pages } = await comic(10)
    const { database, bookIds } = await library([{ name: 'v1.cbz', data }])

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'PAGES_HASHED', pages: 6 })

    const hashes = await storedPageHashes(database, bookIds[0]!)
    for (const [index, bytes] of pages.entries()) {
      const number = index + 1
      const hashed = number <= 3 || number > 7
      expect(hashes.get(number)).toBe(hashed ? await pageHash(bytes) : '')
    }

    await database.close()
  })

  it('are every page when a book is shorter than that', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(4)).data }])

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'PAGES_HASHED', pages: 4 })

    const hashes = await storedPageHashes(database, bookIds[0]!)
    expect([...hashes.values()].filter((hash) => hash !== '')).toHaveLength(4)

    await database.close()
  })

  it('are not computed again for a book that has them', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(10)).data }])
    await hashBookPages(database.db, bookIds[0]!)

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'PAGES_HASHED', pages: 0 })

    await database.close()
  })

  it('are not written when the library stopped asking for them', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }], { hashPages: 0 })

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'DISABLED' })
    expect([...(await storedPageHashes(database, bookIds[0]!)).values()]).toEqual(['', '', ''])

    await database.close()
  })

  it('are none of them for a book that has no pages to hash', async () => {
    const { database, bookIds } = await library([{ name: 'broken.cbz', data: Buffer.from('not a zip at all') }])

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'NO_PAGES' })

    await database.close()
  })

  it('are none of them for a book that has not been analysed', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])
    await database.db.deleteFrom('media').where('book_id', '=', bookIds[0]!).execute()

    expect(await hashBookPages(database.db, bookIds[0]!)).toEqual({ status: 'SKIPPED', reason: 'NO_PAGES' })

    await database.close()
  })
})

describe('the books a library still has to hash', () => {
  it('are the ones without a hash, until they are hashed', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: (await comic(3)).data },
      { name: 'v2.cbz', data: (await comic(3)).data },
    ])

    expect(await booksNeedingFileHash(database.db, 'L1')).toEqual(bookIds)
    expect(await booksNeedingKoreaderHash(database.db, 'L1')).toEqual(bookIds)

    for (const bookId of bookIds) {
      await hashBookFile(database.db, bookId)
      await hashBookKoreader(database.db, bookId)
    }

    expect(await booksNeedingFileHash(database.db, 'L1')).toEqual([])
    expect(await booksNeedingKoreaderHash(database.db, 'L1')).toEqual([])

    await database.close()
  })

  it('are the comic archives with a page hash missing, not the documents', async () => {
    const { database, bookIds } = await library([
      { name: 'v1.cbz', data: (await comic(10)).data },
      { name: 'v2.pdf', data: minimalPdf() },
      { name: 'v3.epub', data: epubBuffer('<dc:title>Story</dc:title>') },
    ])

    expect(await booksNeedingPageHash(database.db, 'L1')).toEqual([bookIds[0]])

    await hashBookPages(database.db, bookIds[0]!)
    expect(await booksNeedingPageHash(database.db, 'L1')).toEqual([])

    await database.close()
  })

  it('are not the books a scan has put in the trash', async () => {
    const { database, bookIds } = await library([{ name: 'v1.cbz', data: (await comic(3)).data }])

    await database.db
      .updateTable('books')
      .set({ deleted_date: new Date().toISOString() })
      .where('id', '=', bookIds[0]!)
      .execute()

    expect(await booksNeedingFileHash(database.db, 'L1')).toEqual([])
    expect(await booksNeedingPageHash(database.db, 'L1')).toEqual([])

    await database.close()
  })
})
