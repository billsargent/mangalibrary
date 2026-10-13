import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { thumbnailBytes } from '../thumbnails/generate.js'
import { confinedPath, insideALibrary } from './files.js'

/** A library folder holding one book, and the URL a scan would store for it. */
function library(): { root: string; book: string; url: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-files-')))
  mkdirSync(join(root, 'Akira'))
  const book = join(root, 'Akira', 'v1.cbz')
  writeFileSync(book, 'book')
  return { root, book, url: pathToFileURL(book).href }
}

describe('confinedPath', () => {
  it('finds a book under the root it was scanned from', async () => {
    const { root, book, url } = library()

    expect(await confinedPath(root, url, 'file')).toBe(book)
    expect(await confinedPath(root, 'Akira/v1.cbz', 'file')).toBe(book)
    expect(await confinedPath(root, 'Akira', 'directory')).toBe(join(root, 'Akira'))
  })

  it('finds a book when the root is a link to where the books are', async () => {
    const { root, book, url } = library()
    // A junction needs no privilege on Windows, and is a plain link elsewhere.
    const link = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-files-link-'))), 'library')
    symlinkSync(root, link, 'junction')

    // The scan stored the book under the folder the link leads to.
    expect(await confinedPath(link, url, 'file')).toBe(book)
  })

  it.runIf(process.platform === 'win32')('finds a book when the root is typed in another letter case', async () => {
    const { root, book, url } = library()
    const typed = root.toLowerCase()
    expect(typed).not.toBe(root)

    expect(await confinedPath(typed, url, 'file')).toBe(book)
  })

  it('refuses a location outside the root', async () => {
    const { root } = library()
    const other = library()

    expect(await confinedPath(root, other.url, 'file')).toBeNull()
    expect(await confinedPath(root, other.book, 'file')).toBeNull()
    expect(await confinedPath(root, '../escape.cbz', 'file')).toBeNull()
  })

  it('refuses a link inside the root that leads out of it', async () => {
    const { root } = library()
    const outside = library()
    symlinkSync(join(outside.root, 'Akira'), join(root, 'Elsewhere'), 'junction')

    expect(await confinedPath(root, 'Elsewhere/v1.cbz', 'file')).toBeNull()
    expect(await confinedPath(root, 'Elsewhere', 'directory')).toBeNull()
  })

  it('finds nothing under a root that is not there', async () => {
    const { root, url } = library()

    expect(await confinedPath(join(root, 'missing'), url, 'file')).toBeNull()
  })
})

describe('a file a row names', () => {
  async function withLibrary() {
    const { root, book } = library()
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    await database.db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'Main', root, created_date: 'now', last_modified_date: 'now' } as never)
      .execute()
    return { root, book, db: database.db }
  }

  it('is inside a library only when it is under one of their folders', async () => {
    const { root, book, db } = await withLibrary()
    const elsewhere = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-files-out-'))), 'secret.jpg')
    writeFileSync(elsewhere, 'secret')

    expect(await insideALibrary(db, book)).toBe(true)
    expect(await insideALibrary(db, join(root, 'Akira'))).toBe(true)
    expect(await insideALibrary(db, elsewhere)).toBe(false)
    expect(await insideALibrary(db, join(root, '..', 'nothing-here.jpg'))).toBe(false)
  })

  it('is read as artwork only from inside a library', async () => {
    const { root, db } = await withLibrary()
    const cover = join(root, 'Akira', 'cover.jpg')
    writeFileSync(cover, 'cover')
    const elsewhere = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-files-out-'))), 'secret.jpg')
    writeFileSync(elsewhere, 'secret')
    const record = (url: string) => ({ id: 'T1', mediaType: 'image/jpeg', bytes: null, url }) as never

    expect((await thumbnailBytes(db, record(cover)))?.toString()).toBe('cover')
    // A row that points outside is answered as if the file were not there.
    expect(await thumbnailBytes(db, record(elsewhere))).toBeNull()
  })
})
