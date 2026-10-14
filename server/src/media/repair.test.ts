import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { scanLibrary } from '../scan/reconcile.js'
import { writeRar } from '../testing/rar.js'
import { writeZip } from '../testing/zip.js'
import { analyzeBook } from './analyze.js'
import { booksToRepair, repairExtension } from './repair.js'

const page = (): Promise<Buffer> =>
  sharp({ create: { width: 20, height: 30, channels: 3, background: { r: 10, g: 60, b: 90 } } })
    .jpeg()
    .toBuffer()

/**
 * A library holding a RAR named `.cbz`, a ZIP named `.zip`, a CBZ named `.cbz`, and a
 * RAR named `.cbz` whose `.cbr` name is already taken - all scanned and analysed.
 */
async function setup(repair = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-repair-')))
  const folder = join(root, 'Akira')
  mkdirSync(folder)
  const jpeg = await page()
  const rar = writeRar([{ name: 'p1.jpg', data: jpeg }])
  const zip = writeZip([{ name: 'p1.jpg', data: jpeg }])
  writeFileSync(join(folder, 'Volume 1.cbz'), rar)
  writeFileSync(join(folder, 'Volume 2.zip'), zip)
  writeFileSync(join(folder, 'Volume 3.cbz'), zip)
  writeFileSync(join(folder, 'Volume 4.cbz'), rar)
  writeFileSync(join(folder, 'Volume 4.cbr'), rar)

  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  await database.db
    .insertInto('libraries')
    .values({
      id: 'L1',
      name: 'Main',
      root,
      repair_extensions: repair ? 1 : 0,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await scanLibrary(database.db, 'L1')
  const books = await database.db.selectFrom('books').select(['id', 'url']).execute()
  for (const book of books) {
    const path = decodeURIComponent(new URL(book.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    await analyzeBook(database.db, book.id, path, { analyzeDimensions: false })
  }
  const byName = new Map(books.map((book) => [decodeURIComponent(book.url.split('/').pop()!), book.id]))
  return { database, folder, id: (name: string) => byName.get(name)! }
}

describe('repairing extensions', () => {
  it('renames each book to what it is, keeps the book, and a scan afterwards finds it there', async () => {
    const { database, folder, id } = await setup()
    const db = database.db

    // A RAR named .cbz and a ZIP named .zip; the CBZ is right; the last cannot be renamed.
    expect((await booksToRepair(db, 'L1')).sort()).toEqual(
      [id('Volume 1.cbz'), id('Volume 2.zip'), id('Volume 4.cbz')].sort(),
    )

    const first = await repairExtension(db, id('Volume 1.cbz'))
    expect(first).toMatchObject({ status: 'REPAIRED', to: join(folder, 'Volume 1.cbr') })
    expect(existsSync(join(folder, 'Volume 1.cbz'))).toBe(false)
    expect(existsSync(join(folder, 'Volume 1.cbr'))).toBe(true)
    const renamed = await db
      .selectFrom('books')
      .select('url')
      .where('id', '=', id('Volume 1.cbz'))
      .executeTakeFirstOrThrow()
    expect(renamed.url).toBe(pathToFileURL(join(folder, 'Volume 1.cbr')).href)

    expect(await repairExtension(db, id('Volume 2.zip'))).toMatchObject({ status: 'REPAIRED' })
    expect(existsSync(join(folder, 'Volume 2.cbz'))).toBe(true)
    expect(await repairExtension(db, id('Volume 3.cbz'))).toEqual({ status: 'MATCHES' })
    // Never over another file.
    expect(await repairExtension(db, id('Volume 4.cbz'))).toEqual({ status: 'EXISTS' })
    expect(existsSync(join(folder, 'Volume 4.cbz'))).toBe(true)

    // The books are where the rows say: a scan adds nothing and loses nothing.
    const summary = await scanLibrary(db, 'L1', { deep: true })
    expect(summary).toMatchObject({ booksCreated: 0, booksDeleted: 0 })
    await database.close()
  })

  it('renames nothing when the library does not ask for it', async () => {
    const { database, folder, id } = await setup(false)
    expect(await booksToRepair(database.db, 'L1')).toEqual([])
    expect(await repairExtension(database.db, id('Volume 1.cbz'))).toEqual({ status: 'DISABLED' })
    expect(existsSync(join(folder, 'Volume 1.cbz'))).toBe(true)
    await database.close()
  })
})
