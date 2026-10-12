import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { updatedTime } from '../content/files.js'
import { naturalCompare } from '../media/kinds.js'
import { insideRoot } from '../media/scan.js'

/** A book file the walk found, before anything is known about its contents. */
export interface ScannedBook {
  /** The file name without its extension, which is Komga's book name. */
  name: string
  /** The absolute path of the file. */
  path: string
  fileSize: number
  fileLastModified: Date
}

/** A directory that holds books directly, with the books it holds. */
export interface ScannedSeries {
  /** The directory name, or the full path when that is blank, as for a root. */
  name: string
  /** The directory itself, or the book's path for a oneshot. */
  path: string
  oneshot: boolean
  fileLastModified: Date
  books: ScannedBook[]
}

/** The parts of a library's settings that decide what a walk finds. */
export interface ScanSettings {
  scanCbx: boolean
  scanPdf: boolean
  scanEpub: boolean
  /** A directory whose path contains this is read as one series per file. */
  oneshotsDirectory: string | null
  /** Paths to avoid, matched as case-insensitive substrings of a directory. */
  exclusions: string[]
  /** When set, a series takes the time of its newest book. */
  forceDirectoryModifiedTime: boolean
}

/**
 * Codes a scan reports when it cannot proceed.
 *
 * The first two are the reference's; an excluded root is our own deliberate
 * departure, so its code is ours as well.
 */
export const LIBRARY_SCAN_ERRORS = {
  notAccessible: 'ERR_1016',
  excludedRoot: 'LIBRARY_EXCLUDED',
} as const

/** A scan that cannot proceed, carrying the code to report. */
export class LibraryScanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LibraryScanError'
  }
}

/** The extensions a library accepts, from its own scanning settings. */
function acceptedExtensions(settings: ScanSettings): string[] {
  const extensions: string[] = []
  if (settings.scanCbx) extensions.push('cbz', 'zip', 'cbr', 'rar')
  if (settings.scanPdf) extensions.push('pdf')
  if (settings.scanEpub) extensions.push('epub')
  return extensions
}

/** Whether a directory is excluded, by a case-insensitive substring of its path. */
function isExcluded(path: string, exclusions: readonly string[]): boolean {
  const lowered = path.toLowerCase()
  return exclusions.some((exclusion) => exclusion !== '' && lowered.includes(exclusion.toLowerCase()))
}

/**
 * Walk a library folder and describe the series and books inside it.
 *
 * The rules are the ones in `docs/SCANNING.md`: which directory becomes a series,
 * what an exclusions pattern matches, what a oneshots folder does, and how the
 * library's own settings decide which extensions count. Nothing here touches the
 * database - this is the walk, and reconciliation against what is already stored
 * is a separate step.
 *
 * Two departures from the reference are deliberate. Symlinks are followed, as
 * they are there, but only while they resolve inside the library root, so a link
 * cannot pull a series in from outside. And an exclusion that matches the root
 * refuses the whole scan rather than reporting an empty folder, which would
 * otherwise look like every book having been deleted.
 */
export async function walkLibrary(root: string, settings: ScanSettings): Promise<ScannedSeries[]> {
  const resolvedRoot = await realpath(root).catch(() => null)
  const rootInfo = resolvedRoot === null ? undefined : await stat(resolvedRoot).catch(() => undefined)
  if (resolvedRoot === null || !rootInfo?.isDirectory()) {
    throw new LibraryScanError(LIBRARY_SCAN_ERRORS.notAccessible, `Folder is not accessible: ${root}`)
  }
  if (isExcluded(resolvedRoot, settings.exclusions)) {
    throw new LibraryScanError(LIBRARY_SCAN_ERRORS.excludedRoot, `The library root is excluded: ${resolvedRoot}`)
  }

  const extensions = acceptedExtensions(settings)
  const oneshots = settings.oneshotsDirectory ?? ''
  const series: ScannedSeries[] = []
  const visited = new Set<string>()

  const visit = async (directory: string): Promise<void> => {
    // A directory reached twice through a link is walked once.
    if (visited.has(directory)) return
    visited.add(directory)

    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((left, right) =>
      naturalCompare(left.name, right.name),
    )
    const books: ScannedBook[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const target = await realpath(join(directory, entry.name)).catch(() => null)
      if (target === null || !insideRoot(resolvedRoot, target)) continue

      const info = await stat(target).catch(() => undefined)
      if (!info) continue

      if (info.isDirectory()) {
        if (isExcluded(target, settings.exclusions)) continue
        await visit(target)
        continue
      }
      if (!info.isFile()) continue

      const extension = entry.name.split('.').pop()?.toLowerCase() ?? ''
      if (!extensions.includes(extension)) continue

      books.push({
        name: entry.name.slice(0, entry.name.length - (extension.length + 1)),
        path: target,
        fileSize: info.size,
        fileLastModified: updatedTime(info),
      })
    }

    // A directory with no book of its own is not a series, though the
    // directories below it may be.
    if (books.length === 0) return
    books.sort((left, right) => naturalCompare(left.name, right.name))

    if (oneshots !== '' && directory.toLowerCase().includes(oneshots.toLowerCase())) {
      // A oneshots folder becomes one series per file, each named after it.
      for (const book of books) {
        series.push({
          name: book.name,
          path: book.path,
          oneshot: true,
          fileLastModified: book.fileLastModified,
          books: [book],
        })
      }
      return
    }

    const directoryTime = await stat(directory)
      .then((info) => updatedTime(info))
      .catch(() => books[0]!.fileLastModified)
    series.push({
      name: basename(directory) || directory,
      path: directory,
      oneshot: false,
      fileLastModified: settings.forceDirectoryModifiedTime
        ? books.reduce(
            (latest, book) => (book.fileLastModified > latest ? book.fileLastModified : latest),
            directoryTime,
          )
        : directoryTime,
      books,
    })
  }

  await visit(resolvedRoot)
  return series
}
