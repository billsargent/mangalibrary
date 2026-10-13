/**
 * The posters a library shows: a book's first page, a series' chosen book, and the
 * mosaic of a collection or a read list.
 *
 * All of it is stored, or computed, the way the reference stores or computes it:
 * one generated thumbnail per book, kept in the `thumbnails` table; a series with
 * none of its own showing the poster of the book its library points at; and a
 * collection or read list showing four of its members side by side.
 */

import { readFile, stat } from 'node:fs/promises'
import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord, insideALibrary } from '../content/files.js'
import type { DB, ThumbnailOwnerType } from '../db/schema.js'
import { SETTING_KEYS, getStringSetting } from '../settings.js'
import { onThread } from '../threads/index.js'
import { nextTsid } from '../tsid.js'
import { maxEdgeFor, mosaic, resizedImage, type RenderedImage } from './image.js'

/** The largest edge a poster is made at, decided by the server setting. */
export async function thumbnailMaxEdge(db: Kysely<DB>): Promise<number> {
  return maxEdgeFor(await getStringSetting(db, SETTING_KEYS.thumbnailSize, 'DEFAULT'))
}

/** A thumbnail row, as the routes and the posters below need it. */
export interface ThumbnailRecord {
  id: string
  type: string
  selected: boolean
  mediaType: string
  width: number
  height: number
  fileSize: number
  /** The image, for a poster this server made or a user uploaded. */
  bytes: Buffer | null
  /** The file it is, for artwork found beside a book or a series. */
  url: string | null
  ownerId: string
}

interface ThumbnailRow {
  id: string
  owner_id: string
  type: string
  selected: number
  media_type: string
  width: number
  height: number
  file_size: number
  thumbnail: Buffer | null
  url: string | null
}

/** A `thumbnails` row, as the routes select them. */
export type { ThumbnailRow }

/** Turn a stored row into what the routes and the posters pass around. */
export function thumbnailRecord(row: ThumbnailRow): ThumbnailRecord {
  return {
    id: row.id,
    type: row.type,
    selected: row.selected === 1,
    mediaType: row.media_type,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    bytes: row.thumbnail,
    url: row.url,
    ownerId: row.owner_id,
  }
}

/**
 * The image of a thumbnail, wherever it lives.
 *
 * A poster this server made is bytes in the row; artwork found beside a book is a
 * file on disk, which is read when it is asked for. Null means the bytes cannot be
 * had - the file has been removed, cannot be read, or is not inside a library,
 * where artwork found beside a book always is.
 */
export async function thumbnailBytes(db: Kysely<DB>, record: ThumbnailRecord): Promise<Buffer | null> {
  if (record.bytes !== null && record.bytes.length > 0) return record.bytes
  if (record.url === null) return null
  if (!(await insideALibrary(db, record.url))) return null
  return await readFile(record.url).catch(() => null)
}

/** Whether a row's image can still be had, without reading all of it. */
async function rowIsReadable(row: ThumbnailRow): Promise<boolean> {
  if (row.thumbnail !== null && row.thumbnail.length > 0) return true
  if (row.url === null) return false
  const file = await stat(row.url).catch(() => null)
  return file !== null && file.isFile()
}

/**
 * The thumbnail to show for an owner: the selected one, else the newest.
 *
 * A row whose file has gone is passed over rather than being answered with a
 * missing image, which is what lets a series with a removed cover fall back to one
 * of its books. The reference does the same in `getSelectedThumbnail`, by deleting
 * such rows as it finds them.
 */
export async function chosenThumbnail(
  db: Kysely<DB>,
  ownerType: ThumbnailOwnerType,
  ownerId: string,
): Promise<ThumbnailRecord | null> {
  const rows = await db
    .selectFrom('thumbnails')
    .selectAll()
    .where('owner_type', '=', ownerType)
    .where('owner_id', '=', ownerId)
    .orderBy('selected', 'desc')
    .orderBy('created_date', 'desc')
    .orderBy('id', 'desc')
    .execute()

  for (const row of rows as unknown as ThumbnailRow[]) {
    if (await rowIsReadable(row)) return thumbnailRecord(row)
  }
  return null
}

/**
 * Generate a book's poster from its first page, and store it.
 *
 * Only one generated poster is kept, as the reference keeps only one, and it is
 * selected unless the book already has a poster of its own chosen - a cover the
 * user uploaded, or one found next to the file, which are not ours to displace.
 */
export async function generateBookThumbnail(
  db: Kysely<DB>,
  bookId: string,
  options: { maxEdge?: number } = {},
): Promise<RenderedImage | null> {
  const record = await findBookRecord(db, bookId)
  if (record === null) return null

  const path = await bookFilePath(record)
  if (path === null) return null

  const poster = await onThread('poster', { path })
  if (poster === null) return null

  const maxEdge = options.maxEdge ?? (await thumbnailMaxEdge(db))
  // What crosses from a thread is bytes, not a buffer; the same memory is looked at as one.
  const bytes = Buffer.from(poster.bytes.buffer, poster.bytes.byteOffset, poster.bytes.byteLength)
  const rendered = await resizedImage(bytes, poster.mediaType, maxEdge)
  if (rendered === null) return null

  const now = new Date().toISOString()
  const id = nextTsid()

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('thumbnails')
      .where('owner_type', '=', 'BOOK')
      .where('owner_id', '=', bookId)
      .where('type', '=', 'GENERATED')
      .execute()

    // Whatever is left is the user's own choice, if any of it is selected.
    const others = await trx
      .selectFrom('thumbnails')
      .select('selected')
      .where('owner_type', '=', 'BOOK')
      .where('owner_id', '=', bookId)
      .execute()
    const selected = others.some((row) => row.selected === 1) ? 0 : 1

    await trx
      .insertInto('thumbnails')
      .values({
        id,
        owner_type: 'BOOK',
        owner_id: bookId,
        type: 'GENERATED',
        page: 1,
        selected,
        media_type: rendered.mediaType,
        width: rendered.width,
        height: rendered.height,
        file_size: rendered.bytes.length,
        thumbnail: rendered.bytes,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
  })

  return rendered
}

/** The books of a series that still need a poster: none, or none of ours. */
export async function booksNeedingThumbnail(
  db: Kysely<DB>,
  options: { libraryId?: string; forBiggerResultOnly?: boolean; maxEdge?: number } = {},
): Promise<string[]> {
  const maxEdge = options.maxEdge ?? (await thumbnailMaxEdge(db))

  let query = db
    .selectFrom('books')
    .leftJoin('thumbnails', (join) =>
      join
        .onRef('thumbnails.owner_id', '=', 'books.id')
        .on('thumbnails.owner_type', '=', 'BOOK')
        .on('thumbnails.type', '=', 'GENERATED'),
    )
    .select(['books.id', 'thumbnails.height', 'thumbnails.width'])
    .where('books.deleted_date', 'is', null)

  if (options.libraryId !== undefined) query = query.where('books.library_id', '=', options.libraryId)

  const rows = await query.execute()
  return rows
    .filter((row) => {
      // Asked for outright, every book is remade; "bigger only" keeps the posters
      // that are already large enough for the size in force now.
      if (options.forBiggerResultOnly !== true) return true
      if (row.height === null || row.width === null) return true
      return Math.max(row.width, row.height) < maxEdge
    })
    .map((row) => row.id)
}

/**
 * The poster to show for a series: its own if it has one, else one of its books.
 *
 * Which book is the library's `seriesCover` setting, and an unread one means the
 * caller has not finished it - so two people looking at the same series can be
 * shown different posters, which is what the reference does.
 */
export async function seriesCoverThumbnail(
  db: Kysely<DB>,
  seriesId: string,
  userId: string,
): Promise<ThumbnailRecord | null> {
  const own = await chosenThumbnail(db, 'SERIES', seriesId)
  if (own !== null) return own

  const series = await db
    .selectFrom('series')
    .innerJoin('libraries', 'libraries.id', 'series.library_id')
    .select('libraries.series_cover')
    .where('series.id', '=', seriesId)
    .executeTakeFirst()
  if (!series) return null

  const books = await db
    .selectFrom('books')
    .leftJoin('read_progress', (join) =>
      join.onRef('read_progress.book_id', '=', 'books.id').on('read_progress.user_id', '=', userId),
    )
    .select(['books.id', 'read_progress.completed'])
    .where('books.series_id', '=', seriesId)
    .where('books.deleted_date', 'is', null)
    .orderBy('books.number')
    .orderBy('books.id')
    .execute()
  if (books.length === 0) return null

  const first = books[0]!
  const last = books[books.length - 1]!
  const firstUnread = books.find((book) => book.completed !== 1)

  const chosen =
    series.series_cover === 'LAST'
      ? last
      : series.series_cover === 'FIRST_UNREAD_OR_LAST'
        ? (firstUnread ?? last)
        : series.series_cover === 'FIRST_UNREAD_OR_FIRST'
          ? (firstUnread ?? first)
          : first

  const poster = await chosenThumbnail(db, 'BOOK', chosen.id)
  if (poster !== null) return poster

  // The book the setting names may have no poster: a file that could not be read,
  // or one not analysed yet. A series with a readable book in it should not look
  // empty for that, so another book stands in: the nearest to the one that was
  // wanted, which from the last book is the one before it. The reference shows
  // nothing here.
  for (const book of chosen === last ? [...books].reverse() : books) {
    if (book.id === chosen.id) continue
    const other = await chosenThumbnail(db, 'BOOK', book.id)
    if (other !== null) return other
  }
  return null
}

/**
 * The first four of a list, repeated when there are fewer.
 *
 * The reference cycles the ids rather than leaving quarters empty, so a collection
 * of one series is four of that series' cover - which is what a reader expects to
 * see.
 */
function fourOf<T>(items: readonly T[]): T[] {
  if (items.length === 0) return []
  return Array.from({ length: 4 }, (_unused, index) => items[index % items.length] as T)
}

/** A mosaic of the first four series of a collection, or null when none has a poster. */
export async function collectionMosaicThumbnail(
  db: Kysely<DB>,
  collectionId: string,
  userId: string,
): Promise<RenderedImage | null> {
  const members = await db
    .selectFrom('collection_series')
    .select('series_id')
    .where('collection_id', '=', collectionId)
    .orderBy('number')
    .orderBy('series_id')
    .limit(4)
    .execute()

  const covers: Buffer[] = []
  for (const seriesId of fourOf(members.map((member) => member.series_id))) {
    const thumbnail = await seriesCoverThumbnail(db, seriesId, userId)
    const bytes = thumbnail === null ? null : await thumbnailBytes(db, thumbnail)
    if (bytes !== null) covers.push(bytes)
  }
  return mosaic(covers, await thumbnailMaxEdge(db))
}

/** A mosaic of the first four books of a read list, or null when none has a poster. */
export async function readListMosaicThumbnail(db: Kysely<DB>, readListId: string): Promise<RenderedImage | null> {
  const members = await db
    .selectFrom('readlist_book')
    .select('book_id')
    .where('readlist_id', '=', readListId)
    .orderBy('number')
    .orderBy('book_id')
    .limit(4)
    .execute()

  const covers: Buffer[] = []
  for (const bookId of fourOf(members.map((member) => member.book_id))) {
    const thumbnail = await chosenThumbnail(db, 'BOOK', bookId)
    const bytes = thumbnail === null ? null : await thumbnailBytes(db, thumbnail)
    if (bytes !== null) covers.push(bytes)
  }
  return mosaic(covers, await thumbnailMaxEdge(db))
}
