import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { confinedPath } from './files.js'

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
