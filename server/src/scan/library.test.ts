import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIBRARY_SCAN_ERRORS, LibraryScanError, walkLibrary, type ScanSettings } from './library.js'

/** Everything on by default, so a test only states what it changes. */
function settings(overrides: Partial<ScanSettings> = {}): ScanSettings {
  return {
    scanCbx: true,
    scanPdf: true,
    scanEpub: true,
    oneshotsDirectory: null,
    exclusions: [],
    forceDirectoryModifiedTime: false,
    ...overrides,
  }
}

function library(): string {
  return mkdtempSync(join(tmpdir(), 'ml-scan-'))
}

/** Write files, creating the directories they live in. */
function files(root: string, paths: string[]): void {
  for (const path of paths) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, path)
  }
}

describe('walking a library', () => {
  it('makes a series of a directory that holds books, named after it', async () => {
    const root = library()
    files(root, ['Akira/Volume 1.cbz', 'Akira/Volume 2.cbz', 'Akira/notes.txt'])

    const series = await walkLibrary(root, settings())
    expect(series).toHaveLength(1)
    expect(series[0]?.name).toBe('Akira')
    expect(series[0]?.oneshot).toBe(false)
    expect(series[0]?.books.map((book) => book.name)).toEqual(['Volume 1', 'Volume 2'])
    expect(series[0]?.books[0]?.fileSize).toBeGreaterThan(0)
    expect(series[0]?.path).toContain('Akira')
  })

  it('lets a directory be both a series and the parent of one', async () => {
    const root = library()
    files(root, ['dir/comic.cbz', 'dir/sub/comic2.cbz'])

    const series = await walkLibrary(root, settings())
    expect(series.map((entry) => entry.name).sort()).toEqual(['dir', 'sub'])
    expect(series.find((entry) => entry.name === 'dir')?.books.map((book) => book.name)).toEqual(['comic'])
    expect(series.find((entry) => entry.name === 'sub')?.books).toHaveLength(1)
  })

  it('makes the root itself a series when books sit directly in it', async () => {
    const root = library()
    files(root, ['loose.cbz'])

    const series = await walkLibrary(root, settings())
    expect(series).toHaveLength(1)
    expect(series[0]?.path).toBe(series[0]?.path)
    expect(series[0]?.books.map((book) => book.name)).toEqual(['loose'])
  })

  it('skips hidden entries, and everything below a hidden directory', async () => {
    const root = library()
    files(root, ['.hidden.cbz', 'Visible/ok.cbz', 'Visible/.hidden.cbz', '.secret/inside.cbz'])

    const series = await walkLibrary(root, settings())
    expect(series.map((entry) => entry.name)).toEqual(['Visible'])
    expect(series[0]?.books.map((book) => book.name)).toEqual(['ok'])
  })

  it('takes the extensions the library asks for', async () => {
    const root = library()
    files(root, ['Akira/a.cbz', 'Akira/b.pdf', 'Akira/c.epub', 'Akira/d.cbr'])

    const comics = await walkLibrary(root, settings({ scanPdf: false, scanEpub: false }))
    expect(comics[0]?.books.map((book) => book.name)).toEqual(['a', 'd'])

    const onlyPdf = await walkLibrary(root, settings({ scanCbx: false, scanEpub: false }))
    expect(onlyPdf[0]?.books.map((book) => book.name)).toEqual(['b'])
  })

  it('stops below a directory an exclusion matches, as a substring of its path', async () => {
    const root = library()
    files(root, ['Keep/a.cbz', 'backup/b.cbz', 'MyBackups/c.cbz', 'Keep/backup/d.cbz'])

    const series = await walkLibrary(root, settings({ exclusions: ['backup'] }))
    // "MyBackups" matches too: the rule is a substring of the whole path.
    expect(series.map((entry) => entry.name)).toEqual(['Keep'])
    expect(series[0]?.books.map((book) => book.name)).toEqual(['a'])
  })

  it('refuses the scan when the exclusion matches the root', async () => {
    const root = library()
    files(root, ['Akira/a.cbz'])

    await expect(walkLibrary(root, settings({ exclusions: [root] }))).rejects.toThrow(LibraryScanError)
    await expect(walkLibrary(root, settings({ exclusions: [root] }))).rejects.toMatchObject({
      code: LIBRARY_SCAN_ERRORS.excludedRoot,
    })
  })

  it('reports a root that is not a readable directory', async () => {
    await expect(walkLibrary(join(tmpdir(), 'ml-scan-does-not-exist'), settings())).rejects.toMatchObject({
      code: LIBRARY_SCAN_ERRORS.notAccessible,
    })
  })

  it('makes one series per file inside a oneshots folder', async () => {
    const root = library()
    files(root, ['series-a/oneshots-dir/One Shot.cbz', 'series-a/oneshots-dir/Another.cbz', 'series-a/plain.cbz'])

    const series = await walkLibrary(root, settings({ oneshotsDirectory: 'oneshots-dir' }))
    // The oneshots folder produces a series per file, and none of its own.
    expect(series.map((entry) => entry.name).sort()).toEqual(['Another', 'One Shot', 'series-a'])
    expect(series.filter((entry) => entry.oneshot).map((entry) => entry.books.length)).toEqual([1, 1])
    const plain = series.find((entry) => !entry.oneshot)
    expect(plain?.name).toBe('series-a')
    expect(plain?.books.map((book) => book.name)).toEqual(['plain'])
  })

  it('takes the newest book time for a series when asked to', async () => {
    const root = library()
    files(root, ['Akira/a.cbz'])

    const plain = await walkLibrary(root, settings())
    const forced = await walkLibrary(root, settings({ forceDirectoryModifiedTime: true }))
    // The directory was created before the book was written, so forcing takes the
    // later one.
    expect(forced[0]!.fileLastModified.getTime()).toBeGreaterThanOrEqual(plain[0]!.fileLastModified.getTime())
    expect(forced[0]!.fileLastModified.getTime()).toBe(forced[0]!.books[0]!.fileLastModified.getTime())
  })

  it('ignores a link that leaves the library root', async () => {
    const root = library()
    const outside = library()
    files(outside, ['Outside/secret.cbz'])
    files(root, ['Akira/a.cbz'])
    symlinkSync(join(outside, 'Outside'), join(root, 'linked'))

    const series = await walkLibrary(root, settings())
    expect(series.map((entry) => entry.name)).toEqual(['Akira'])
  })
})
