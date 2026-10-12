import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

import { containerFor } from './kinds.js'

/** A book file found by a scan, before anything is known about its contents. */
export interface ScannedBook {
  /** The file name without its extension, which is Komga's book name. */
  name: string
  /** The absolute path of the file, which the DTO reports as `url`. */
  path: string
  fileSize: number
  fileLastModified: Date
}

/**
 * Codes the reference reports when a folder cannot be scanned, kept so a client
 * that reads them keeps working.
 */
export const SCAN_ERRORS = {
  notAccessible: 'ERR_1016',
  insideLibrary: 'ERR_1017',
} as const

/** A scan that cannot proceed, carrying the code the reference reports. */
export class ScanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ScanError'
  }
}

/** Whether `candidate` is `root` or sits inside it, by whole path segments. */
export function insideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep)
}

/**
 * Whether `candidate` is `root` or sits inside it, as the disk spells them both.
 *
 * A path can be typed in more than one way - another letter case on a filesystem
 * that ignores it, a mapped drive, a link - and comparing what was typed would
 * call the same folder two different places. A path that does not resolve is
 * inside nothing.
 */
export async function insideRootOnDisk(root: string, candidate: string): Promise<boolean> {
  const [resolvedRoot, resolved] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(candidate).catch(() => null),
  ])
  return resolvedRoot !== null && resolved !== null && insideRoot(resolvedRoot, resolved)
}

/**
 * Every book file under a folder.
 *
 * This is the part of Komga's `FileSystemScanner` that transient-book scanning
 * uses: all four container extensions, no exclusions, no oneshots folder and no
 * database. The walk follows directory symlinks, as the reference does, but only
 * after resolving the target and checking that it stays inside the folder - the
 * same guard the file download endpoint uses - so a link cannot pull a file from
 * outside the tree into a scan. A directory reached twice through a link is
 * visited once, which the reference gets from its walker's cycle detection.
 */
export async function scanFolder(folder: string): Promise<ScannedBook[]> {
  const root = await realpath(folder).catch(() => null)
  const rootInfo = root === null ? undefined : await stat(root).catch(() => undefined)
  if (root === null || !rootInfo?.isDirectory()) {
    throw new ScanError(SCAN_ERRORS.notAccessible, `Folder is not accessible: ${folder}`)
  }

  const books: ScannedBook[] = []
  const visited = new Set<string>()

  const visit = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return
    visited.add(directory)

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const target = await realpath(join(directory, entry.name)).catch(() => null)
      if (target === null || !insideRoot(root, target)) continue

      const info = await stat(target).catch(() => undefined)
      if (!info) continue
      if (info.isDirectory()) {
        await visit(target)
        continue
      }
      if (!info.isFile() || containerFor(entry.name) === null) continue

      books.push({
        name: basename(entry.name, extname(entry.name)),
        path: target,
        fileSize: info.size,
        // Komga takes the later of the creation and modified times.
        fileLastModified: info.birthtime > info.mtime ? info.birthtime : info.mtime,
      })
    }
  }

  await visit(root)
  return books
}
