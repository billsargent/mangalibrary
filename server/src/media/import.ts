/**
 * Bringing a file that is somewhere on the server into a series.
 *
 * This is what the Import page does with each file it is given: the file is
 * moved, copied or hard-linked into the series' folder, and becomes a book of the
 * series - or takes the place of a book that is already there, which the
 * reference calls an upgrade and is how a better scan replaces a worse one.
 *
 * The reference does this in `BookImporter.importBook`. One thing is done
 * differently on purpose. There an upgrade makes a new book and carries the old
 * one's progress, metadata and read-list places across to it; here the book that
 * is upgraded stays the book it was and is pointed at the new file, so nothing has
 * to be carried anywhere and nothing can be dropped on the way.
 */

import { copyFile, link, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Kysely } from 'kysely'

import { bookFilePath, confinedPath, findBookRecord, insideALibrary, updatedTime } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { bookArtwork } from '../metadata/localArtwork.js'
import { addBooks, sortBooks } from '../scan/reconcile.js'
import { nextTsid } from '../tsid.js'
import { containerFor } from './index.js'

export const COPY_MODES = ['MOVE', 'COPY', 'HARDLINK'] as const
export type CopyMode = (typeof COPY_MODES)[number]

export interface ImportRequest {
  /** Where the file is now. */
  sourceFile: string
  seriesId: string
  copyMode: CopyMode
  /** The name the file is to have in the series, without its extension. */
  destinationName?: string | null
  /** The book this file replaces. */
  upgradeBookId?: string | null
}

/**
 * Why a file could not be imported, with the reference's code where it has one:
 * the web UI turns the code into the sentence it shows.
 */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }

  /** What a client is told: the code when there is one, as the reference sends it. */
  get reported(): string {
    return this.code ?? this.message
  }
}

/** Put a file where it is going, by the way that was asked for. */
async function place(source: string, target: string, mode: CopyMode): Promise<void> {
  if (mode === 'MOVE') {
    try {
      await rename(source, target)
    } catch {
      // Another drive: a move across drives is a copy and a removal.
      await copyFile(source, target)
      await unlink(source)
    }
    return
  }
  if (mode === 'HARDLINK') {
    try {
      await link(source, target)
      return
    } catch {
      // A filesystem without hard links, or two drives: copied instead, as the
      // reference does, rather than failing an import over how it was stored.
    }
  }
  await copyFile(source, target)
}

/**
 * Import one file. Returns the book it became and whether that was an upgrade.
 * Throws an {@link ImportError} for anything a person can act on.
 */
export async function importBook(
  db: Kysely<DB>,
  request: ImportRequest,
): Promise<{ bookId: string; upgraded: boolean }> {
  const source = request.sourceFile
  const info = await stat(source).catch(() => null)
  if (info === null || !info.isFile()) throw new ImportError(`File not found: ${source}`, 'ERR_1018')
  if (containerFor(basename(source)) === null) {
    throw new ImportError(`Newly imported book could not be scanned: ${source}`, 'ERR_1022')
  }

  const series = await db
    .selectFrom('series')
    .innerJoin('libraries', 'libraries.id', 'series.library_id')
    .select(['series.id', 'series.url', 'series.oneshot', 'series.library_id', 'libraries.root'])
    .where('series.id', '=', request.seriesId)
    .where('series.deleted_date', 'is', null)
    .executeTakeFirst()
  if (!series) throw new ImportError(`Series does not exist: ${request.seriesId}`)

  const upgradeId = request.upgradeBookId ?? null
  if (series.oneshot === 1 && upgradeId === null) {
    throw new ImportError('Destination series is oneshot but upgradeBookId is missing')
  }
  // A file already in a library is a book already: importing it would make two.
  if (await insideALibrary(db, source)) {
    throw new ImportError('Cannot import file that is part of an existing library', 'ERR_1019')
  }

  let upgrading: { id: string; path: string | null } | null = null
  if (upgradeId !== null) {
    const book = await db
      .selectFrom('books')
      .select(['id', 'series_id'])
      .where('id', '=', upgradeId)
      .where('deleted_date', 'is', null)
      .executeTakeFirst()
    if (!book || book.series_id !== series.id) {
      throw new ImportError(`Book to upgrade (${upgradeId}) does not belong to series: ${series.id}`, 'ERR_1020')
    }
    const record = await findBookRecord(db, upgradeId)
    upgrading = { id: upgradeId, path: record === null ? null : await bookFilePath(record) }
  }

  // A oneshot is a series that is one file, so its "folder" is the folder the file is in.
  const folder =
    series.oneshot === 1
      ? await confinedPath(series.root, pathToFileURL(dirname(fileURLToPath(series.url))).href, 'directory')
      : await confinedPath(series.root, series.url, 'directory')
  if (folder === null) throw new ImportError(`Series folder is not accessible: ${series.url}`, 'ERR_1016')

  // Only a name: whatever was typed, the file goes into the series' folder and nowhere else.
  const wantedName = request.destinationName?.trim() ? basename(request.destinationName.trim()) : null
  const target = join(folder, wantedName === null ? basename(source) : `${wantedName}${extname(source)}`)

  const now = new Date().toISOString()
  const history: { type: 'BOOK_FILE_DELETED' | 'BOOK_IMPORTED'; bookId: string; properties: Record<string, string> }[] =
    []
  const removedForUpgrade = (path: string): void => {
    history.push({
      type: 'BOOK_FILE_DELETED',
      bookId: upgrading!.id,
      properties: { name: path, reason: 'File was deleted to import an upgrade' },
    })
  }

  const targetExists = (await stat(target).catch(() => null)) !== null
  const replacesInPlace = upgrading?.path != null && samePath(upgrading.path, target)
  if (targetExists && !replacesInPlace) {
    throw new ImportError(`Destination file already exists: ${target}`, 'ERR_1021')
  }

  // The artwork beside the file comes with it, under the file's new name.
  const artwork = (await bookArtwork(source)).map((entry) => ({
    from: entry.path,
    to: join(
      folder,
      wantedName === null ? basename(entry.path) : basename(entry.path).replace(parse(source).name, wantedName),
    ),
  }))

  if (replacesInPlace && targetExists) {
    await unlink(target)
    removedForUpgrade(target)
  }
  await place(source, target, request.copyMode)
  for (const entry of artwork) {
    await unlink(entry.to).catch(() => undefined)
    await place(entry.from, entry.to, request.copyMode).catch(() => undefined)
  }

  const written = await stat(target).catch(() => null)
  if (written === null) throw new ImportError(`Newly imported book could not be scanned: ${target}`, 'ERR_1022')
  const file = {
    name: parse(target).name,
    path: target,
    fileSize: written.size,
    fileLastModified: updatedTime(written),
  }

  let bookId: string
  await db.transaction().execute(async (trx) => {
    if (upgrading === null) {
      const [added] = await addBooks(trx, series.id, series.library_id, [file], now)
      bookId = added!
    } else {
      bookId = upgrading.id
      await trx
        .updateTable('books')
        .set({
          name: file.name,
          url: pathToFileURL(target).href,
          file_size: file.fileSize,
          file_last_modified: file.fileLastModified.toISOString(),
          // Hashes of the file that was replaced are not hashes of this one.
          file_hash: null,
          file_hash_koreader: null,
          last_modified_date: now,
        })
        .where('id', '=', bookId)
        .execute()
      // What analysis recorded described the old file.
      await trx
        .updateTable('media')
        .set({ status: 'OUTDATED', last_modified_date: now })
        .where('book_id', '=', bookId)
        .execute()
      // A oneshot is known to a scan by its file, so the series follows the book.
      if (series.oneshot === 1) {
        await trx
          .updateTable('series')
          .set({
            name: file.name,
            url: pathToFileURL(target).href,
            file_last_modified: file.fileLastModified.toISOString(),
            last_modified_date: now,
          })
          .where('id', '=', series.id)
          .execute()
      }
    }
    await sortBooks(trx, series.id, now)
  })

  // The file the upgraded book had, when the new one did not land on top of it.
  if (upgrading?.path != null && !replacesInPlace) {
    const removed = await unlink(upgrading.path).then(
      () => true,
      () => false,
    )
    if (removed) removedForUpgrade(upgrading.path)
  }

  history.push({
    type: 'BOOK_IMPORTED',
    bookId: bookId!,
    properties: { name: target, source, upgrade: upgrading === null ? 'No' : 'Yes' },
  })
  await db
    .insertInto('historical_events')
    .values(
      history.map((event) => ({
        id: nextTsid(),
        type: event.type,
        book_id: event.bookId,
        series_id: series.id,
        properties: JSON.stringify(event.properties),
        timestamp: now,
      })),
    )
    .execute()

  return { bookId: bookId!, upgraded: upgrading !== null }
}

/** Whether two paths name one file, on a disk that may not care about letter case. */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
