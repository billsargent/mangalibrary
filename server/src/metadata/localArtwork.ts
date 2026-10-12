/**
 * Artwork found beside a book rather than inside it.
 *
 * A cover that was never put in the archive - `Volume 1.jpg` next to
 * `Volume 1.cbz`, or `cover.png` in a series' folder - is what the reference calls
 * local artwork. It is not copied into the database: the row records the file it
 * is, and the file is read when the image is asked for, so replacing a large cover
 * costs nothing.
 *
 * A file is matched by name and extension, and then checked to be an image, which
 * is what stops a `Volume 1.txt` or a text file with a misleading extension from
 * becoming a cover.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Kysely } from 'kysely'
import sharp from 'sharp'

import { bookFilePath, findBookRecord, findSeriesRecord, seriesFolderPath } from '../content/files.js'
import type { DB, ThumbnailOwnerType } from '../db/schema.js'
import { nextTsid } from '../tsid.js'

/** The extensions the reference accepts for local artwork. */
export const ARTWORK_EXTENSIONS = ['png', 'jpeg', 'jpg', 'tbn', 'webp', 'gif'] as const

/** The names a series' own cover may have. */
export const SERIES_ARTWORK_NAMES = ['cover', 'default', 'folder', 'poster', 'series'] as const

/** An artwork file found on disk. */
export interface LocalArtwork {
  path: string
  mediaType: string
  fileSize: number
  width: number
  height: number
}

/** The media type for an image, by the format sharp finds it in. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  tiff: 'image/tiff',
  heif: 'image/heif',
  jxl: 'image/jxl',
}

/** The files in a folder, in a stable order that does not put cases apart. */
async function listFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => {
      const byName = left.toLowerCase().localeCompare(right.toLowerCase())
      return byName === 0 ? left.localeCompare(right) : byName
    })
}

/** Whether a name has an extension local artwork may have. */
function hasArtworkExtension(name: string): boolean {
  const extension = extname(name).slice(1).toLowerCase()
  return (ARTWORK_EXTENSIONS as readonly string[]).includes(extension)
}

/**
 * The artwork files that match, with the sizes a thumbnail row records.
 *
 * The type is taken from the file's content rather than its extension, which is
 * what the reference's detection does - a `.tbn` is a thumbnail whatever it was
 * written as - and a file that cannot be read as an image is left out rather than
 * stored.
 */
async function describe(folder: string, names: string[]): Promise<LocalArtwork[]> {
  const artwork: LocalArtwork[] = []
  for (const name of names) {
    const path = join(folder, name)
    try {
      const info = await stat(path)
      const metadata = await sharp(path).metadata()
      const mediaType = IMAGE_MEDIA_TYPES[metadata.format ?? '']
      if (mediaType === undefined) continue

      artwork.push({
        path,
        mediaType,
        fileSize: info.size,
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
      })
    } catch {
      // Not an image this server can read; a cover of something else is no cover.
    }
  }
  return artwork
}

/**
 * The artwork for a book: files in its folder named after it.
 *
 * `Volume 1.jpg`, `Volume 1-1.jpg` and `Volume 1-2.jpg` all belong to
 * `Volume 1.cbz`, which is the reference's rule; the first in name order is the one
 * that gets selected.
 */
export async function bookArtwork(bookPath: string): Promise<LocalArtwork[]> {
  const folder = dirname(bookPath)
  const base = basename(bookPath, extname(bookPath))
  const pattern = new RegExp(`^${escapeForPattern(base)}(-\\d+)?$`, 'i')

  const names = (await listFiles(folder)).filter(
    (name) => hasArtworkExtension(name) && pattern.test(basename(name, extname(name))),
  )
  return describe(folder, names)
}

/**
 * The artwork for a series: the files in its folder that are named like a cover.
 *
 * A oneshot series is skipped, as the reference skips it: its "folder" is the
 * library root, where a stray `cover.jpg` belongs to no series in particular.
 */
export async function seriesArtwork(folder: string, options: { oneshot: boolean }): Promise<LocalArtwork[]> {
  if (options.oneshot) return []

  const names = (await listFiles(folder)).filter(
    (name) =>
      hasArtworkExtension(name) &&
      (SERIES_ARTWORK_NAMES as readonly string[]).includes(basename(name, extname(name)).toLowerCase()),
  )
  return describe(folder, names)
}

/** Escape a book's name so it can be matched literally in a file name. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Store a set of artwork files as an owner's sidecar thumbnails.
 *
 * The reference keeps one row per file, re-inserting the row for a file it has
 * seen before, and removes the rows for files that have gone. The first file is
 * selected only when the owner has no choice of its own to displace - an uploaded
 * poster, or a poster this server generated, is beaten by a cover the user placed
 * beside the book, which is what the reference's `IF_NONE_OR_GENERATED` means.
 */
async function storeArtwork(
  db: Kysely<DB>,
  ownerType: ThumbnailOwnerType,
  ownerId: string,
  artwork: readonly LocalArtwork[],
): Promise<number> {
  const existing = await db
    .selectFrom('thumbnails')
    .select(['id', 'url', 'type'])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .where('type', '=', 'SIDECAR')
    .execute()

  const found = new Set(artwork.map((file) => file.path))
  const gone = existing.filter((row) => row.url === null || !found.has(row.url))

  const first = artwork[0]
  const selectFirst = first !== undefined && !(await hasChosenArtwork(db, ownerType, ownerId, first.path))

  const now = new Date().toISOString()
  await db.transaction().execute(async (trx) => {
    if (gone.length > 0) {
      await trx
        .deleteFrom('thumbnails')
        .where(
          'id',
          'in',
          gone.map((row) => row.id),
        )
        .execute()
    }

    // A row for a file that is still there is replaced, so a changed cover is
    // picked up even though the file name has not changed.
    const replaced = artwork
      .map((file) => existing.find((row) => row.url === file.path))
      .filter((row) => row !== undefined)
      .map((row) => row.id)
    if (replaced.length > 0) await trx.deleteFrom('thumbnails').where('id', 'in', replaced).execute()

    // Only one poster is ever the chosen one, so the rest are stood down first.
    if (selectFirst) {
      await trx
        .updateTable('thumbnails')
        .set({ selected: 0 })
        .where('owner_type', '=', ownerType)
        .where('owner_id', '=', ownerId)
        .execute()
    }

    for (const [index, file] of artwork.entries()) {
      await trx
        .insertInto('thumbnails')
        .values({
          id: nextTsid(),
          owner_type: ownerType,
          owner_id: ownerId,
          type: 'SIDECAR',
          page: 0,
          selected: selectFirst && index === 0 ? 1 : 0,
          media_type: file.mediaType,
          width: file.width,
          height: file.height,
          file_size: file.fileSize,
          thumbnail: null,
          url: file.path,
          created_date: now,
          last_modified_date: now,
        })
        .execute()
    }
  })

  return artwork.length
}

/**
 * Whether the owner already has artwork of its own that a local cover must not
 * displace: an upload, or another file of the owner's that the user has chosen.
 */
async function hasChosenArtwork(
  db: Kysely<DB>,
  ownerType: ThumbnailOwnerType,
  ownerId: string,
  url: string,
): Promise<boolean> {
  const rows = await db
    .selectFrom('thumbnails')
    .select(['type', 'url'])
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .where('selected', '=', 1)
    .execute()

  return rows.some((row) => {
    if (row.type === 'GENERATED') return false
    if (row.type === 'USER') return true
    // A sidecar that is this same file is not a choice distinct from this one.
    return row.url !== url
  })
}

/**
 * Look for artwork beside a book and store what is found.
 *
 * Returns how many files were stored, which is what a caller can report on.
 */
export async function refreshBookLocalArtwork(db: Kysely<DB>, bookId: string): Promise<number> {
  const record = await findBookRecord(db, bookId)
  if (record === null) return 0
  if (!(await importsLocalArtwork(db, record.libraryId))) return 0

  const path = await bookFilePath(record)
  if (path === null) return 0

  return await storeArtwork(db, 'BOOK', bookId, await bookArtwork(path))
}

/** Look for a cover in a series' folder and store what is found. */
export async function refreshSeriesLocalArtwork(db: Kysely<DB>, seriesId: string): Promise<number> {
  const record = await findSeriesRecord(db, seriesId)
  if (record === null) return 0
  if (!(await importsLocalArtwork(db, record.libraryId))) return 0

  const folder = await seriesFolderPath(record)
  if (folder === null) return 0

  const series = await db.selectFrom('series').select('oneshot').where('id', '=', seriesId).executeTakeFirst()
  const artwork = await seriesArtwork(folder, { oneshot: series?.oneshot === 1 })
  return await storeArtwork(db, 'SERIES', seriesId, artwork)
}

/** Whether a library is set to import artwork found beside its books. */
async function importsLocalArtwork(db: Kysely<DB>, libraryId: string): Promise<boolean> {
  const library = await db
    .selectFrom('libraries')
    .select('import_local_artwork')
    .where('id', '=', libraryId)
    .executeTakeFirst()
  return library?.import_local_artwork === 1
}
