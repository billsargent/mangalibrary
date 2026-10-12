import { existsSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeZip } from '../testing/zip.js'
import { openBook } from './index.js'
import { openZip } from './zip.js'

function archive(files: { name: string; data: Buffer }[], name = 'book.cbz'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ml-zip-')), name)
  writeFileSync(path, writeZip(files))
  return path
}

const pages = [
  { name: '01.png', data: Buffer.from('first page') },
  { name: '02.png', data: Buffer.from('second page, a little longer') },
  { name: 'notes/readme.txt', data: Buffer.from('not a page') },
]

describe('openZip', () => {
  it('lists and reads the entries of an archive on disk', async () => {
    const zip = await openZip(archive(pages))
    try {
      expect(zip.entries).toEqual(['01.png', '02.png', 'notes/readme.txt'])
      expect(zip.sizes.get('02.png')).toBe(pages[1]!.data.length)
      // Out of order, and more than once: an entry is found where it lies.
      expect((await zip.read('notes/readme.txt')).toString()).toBe('not a page')
      expect((await zip.read('01.png')).toString()).toBe('first page')
      expect((await zip.read('01.png')).toString()).toBe('first page')
    } finally {
      zip.close()
    }
  })

  it('reads several entries at once', async () => {
    const zip = await openZip(archive(pages))
    try {
      const read = await Promise.all(pages.map((page) => zip.read(page.name)))
      expect(read.map(String)).toEqual(pages.map((page) => page.data.toString()))
    } finally {
      zip.close()
    }
  })

  it('reads an archive already in memory the same way', async () => {
    const zip = await openZip(writeZip(pages))
    try {
      expect(zip.entries).toHaveLength(3)
      expect((await zip.read('02.png')).toString()).toBe('second page, a little longer')
    } finally {
      zip.close()
    }
  })

  it('lets go of the file when it is closed', async () => {
    const path = archive(pages)
    const zip = await openZip(path)
    await zip.read('01.png')
    zip.close()

    // A book is replaced and deleted by the server itself; a reader that had
    // finished with it must not be what stops that.
    const moved = `${path}.moved`
    renameSync(path, moved)
    unlinkSync(moved)
    expect(existsSync(moved)).toBe(false)
  })

  it('refuses an entry larger than it is willing to hold', async () => {
    const zip = await openZip(archive(pages), { maxEntryBytes: 12 })
    try {
      expect((await zip.read('01.png')).toString()).toBe('first page')
      await expect(zip.read('02.png')).rejects.toThrow(/too large/)
    } finally {
      zip.close()
    }
  })

  it('rejects a name the archive does not hold', async () => {
    const zip = await openZip(archive(pages))
    try {
      await expect(zip.read('missing.png')).rejects.toThrow(/no entry named/)
    } finally {
      zip.close()
    }
  })

  it('rejects a file that is not an archive, and leaves it free', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ml-zip-')), 'book.cbz')
    writeFileSync(path, 'this is not a zip at all')

    await expect(openZip(path)).rejects.toThrow()
    unlinkSync(path)
    expect(existsSync(path)).toBe(false)
  })

  it('rejects a file that is not there', async () => {
    await expect(openZip(join(tmpdir(), 'ml-zip-missing', 'book.cbz'))).rejects.toThrow()
  })
})

describe('openBook', () => {
  it('reads the pages of a CBZ from disk, in reading order', async () => {
    const path = archive([
      { name: '10.png', data: Buffer.from('ten') },
      { name: '2.png', data: Buffer.from('two') },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
    ])

    const book = await openBook(path)
    try {
      expect(book.pages.map((page) => page.fileName)).toEqual(['2.png', '10.png'])
      expect((await book.readPage(2)).toString()).toBe('ten')
      expect((await book.readResource('ComicInfo.xml')).toString()).toBe('<ComicInfo/>')
    } finally {
      book.close()
    }

    unlinkSync(path)
    expect(existsSync(path)).toBe(false)
  })

  it('leaves an EPUB it cannot describe free', async () => {
    const path = archive([{ name: 'mimetype', data: Buffer.from('application/epub+zip') }], 'book.epub')

    await expect(openBook(path)).rejects.toThrow()
    unlinkSync(path)
    expect(existsSync(path)).toBe(false)
  })
})
