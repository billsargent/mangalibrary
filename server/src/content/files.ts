import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { insideRoot } from '../media/scan.js'

/**
 * Where the rows of a library point, and how to get there.
 *
 * This lives outside the routes because more than the routes need it: a download
 * has to find a book's file, reading metadata has to find it too, and a series'
 * sidecar sits in the folder the series row names.
 */

/** A book and its library root, as stored, without touching the filesystem. */
export interface BookFileRecord {
  libraryId: string
  seriesId: string
  name: string
  /** Where the row says the file is: an absolute `file:` URL, or a relative path. */
  url: string
  /** The library root, as configured. */
  root: string
}

/** A series and its library root, as stored, without touching the filesystem. */
export interface SeriesFolderRecord {
  libraryId: string
  name: string
  url: string
  root: string
}

/**
 * Paths a stored location could mean, most specific first.
 *
 * Komga stores absolute `file:` URLs - the importer copies them across
 * unchanged - while a row written by hand or by a future scanner may hold a path
 * relative to the library root. Both are accepted so that a migrated library and
 * a freshly scanned one behave the same way.
 */
function storedPathCandidates(root: string, url: string): string[] {
  const candidates: string[] = []
  if (url.startsWith('file:')) {
    try {
      candidates.push(fileURLToPath(url))
    } catch {
      // Not a usable file URL; the relative interpretation below may still work.
    }
  } else if (isAbsolute(url)) {
    candidates.push(url)
  }
  candidates.push(resolve(root, url))
  return candidates
}

/**
 * A file or folder a row points at, or null.
 *
 * Every candidate is confined to the library root, so a row can never point the
 * server at an arbitrary file - including one that arrives from an imported
 * database.
 */
export async function confinedPath(root: string, url: string, kind: 'file' | 'directory'): Promise<string | null> {
  for (const candidate of storedPathCandidates(root, url)) {
    if (!insideRoot(root, candidate)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (kind === 'file' ? info?.isFile() : info?.isDirectory()) return candidate
  }
  return null
}

/** A book row joined to its library, or null when there is no such book. */
export async function findBookRecord(db: Kysely<DB>, bookId: string): Promise<BookFileRecord | null> {
  const row = await db
    .selectFrom('books')
    .innerJoin('libraries', 'libraries.id', 'books.library_id')
    .select(['books.url', 'books.name', 'books.library_id', 'books.series_id', 'libraries.root'])
    .where('books.id', '=', bookId)
    .executeTakeFirst()
  if (!row) return null

  return {
    libraryId: row.library_id,
    seriesId: row.series_id,
    name: row.name,
    url: row.url,
    root: row.root,
  }
}

/** A book's file on disk, or null. */
export async function bookFilePath(record: BookFileRecord): Promise<string | null> {
  return confinedPath(record.root, record.url, 'file')
}

/** A series row joined to its library, or null when there is no such series. */
export async function findSeriesRecord(db: Kysely<DB>, seriesId: string): Promise<SeriesFolderRecord | null> {
  const row = await db
    .selectFrom('series')
    .innerJoin('libraries', 'libraries.id', 'series.library_id')
    .select(['series.url', 'series.name', 'series.library_id', 'libraries.root'])
    .where('series.id', '=', seriesId)
    .executeTakeFirst()
  if (!row) return null

  return { libraryId: row.library_id, name: row.name, url: row.url, root: row.root }
}

/** A series' folder on disk, or null when it is not there. */
export async function seriesFolderPath(record: SeriesFolderRecord): Promise<string | null> {
  const folder = await confinedPath(record.root, record.url, 'directory')
  if (folder !== null) return folder

  // A series the library holds as loose files has the library root as its folder,
  // which the stored URL may not name at all.
  return confinedPath(record.root, '.', 'directory')
}

/** One file of a book, as it goes into an archive. */
export interface ArchiveEntry {
  name: string
  path: string
}

/**
 * Archive entries for a list of books, in the order given.
 *
 * A book whose file has gone is skipped rather than failing the whole download,
 * as the reference does. The entry name is left to the caller, because a series
 * names its entries after the files and a read list numbers them.
 */
export async function archiveEntries(
  db: Kysely<DB>,
  bookIds: readonly string[],
  name: (fileName: string, index: number) => string,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  for (const [index, bookId] of bookIds.entries()) {
    const record = await findBookRecord(db, bookId)
    if (!record) continue
    const path = await bookFilePath(record)
    if (!path) continue
    entries.push({ name: name(basename(path), index), path })
  }
  return entries
}
