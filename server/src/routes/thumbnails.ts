import { type Kysely } from 'kysely'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { requireAdmin, requireAuth } from '../auth/session.js'
import type { DB, ThumbnailOwnerType } from '../db/schema.js'
import {
  chosenThumbnail,
  collectionMosaicThumbnail,
  readListMosaicThumbnail,
  seriesCoverThumbnail,
  thumbnailRecord,
  type ThumbnailRecord,
  type ThumbnailRow,
} from '../thumbnails/generate.js'
import { nextTsid } from '../tsid.js'
import { accessibleSeriesIds, contentContext, type ContentContext } from './context.js'
import type { RouteOptions } from './libraries.js'

/**
 * Artwork for books, series, collections and read lists.
 *
 * Thumbnails live in the `thumbnails` table as bytes, so serving them needs no
 * access to the library on disk. The four owners differ only in their path
 * segment, their id field in the DTO, and how visibility is decided, so the
 * routes are registered from one table.
 */

interface OwnerSpec {
  /** Path segment, e.g. `books`. */
  segment: string
  /** Fastify parameter carrying the owner id, e.g. `bookId`. */
  param: string
  ownerType: ThumbnailOwnerType
  /** Field the DTO uses for the owner id, e.g. `bookId`. */
  idField: string
}

const OWNERS: OwnerSpec[] = [
  { segment: 'books', param: 'bookId', ownerType: 'BOOK', idField: 'bookId' },
  { segment: 'series', param: 'seriesId', ownerType: 'SERIES', idField: 'seriesId' },
  { segment: 'collections', param: 'id', ownerType: 'COLLECTION', idField: 'collectionId' },
  { segment: 'readlists', param: 'id', ownerType: 'READLIST', idField: 'readListId' },
]

const OWNER_TABLE: Record<ThumbnailOwnerType, 'books' | 'series' | 'collections' | 'readlists'> = {
  BOOK: 'books',
  SERIES: 'series',
  COLLECTION: 'collections',
  READLIST: 'readlists',
}

/** Event prefix per owner type; the suffix is `Added` or `Deleted`. */
const EVENT_PREFIX: Record<
  ThumbnailOwnerType,
  'ThumbnailBook' | 'ThumbnailSeries' | 'ThumbnailSeriesCollection' | 'ThumbnailReadList'
> = {
  BOOK: 'ThumbnailBook',
  SERIES: 'ThumbnailSeries',
  COLLECTION: 'ThumbnailSeriesCollection',
  READLIST: 'ThumbnailReadList',
}

/** DTO shape is the same for every owner, with one renamed id field. */
function toThumbnailDto(record: ThumbnailRecord, spec: OwnerSpec): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    selected: record.selected,
    mediaType: record.mediaType,
    width: record.width,
    height: record.height,
    fileSize: record.fileSize,
    [spec.idField]: record.ownerId,
  }
}

/**
 * The body of a thumbnail event.
 *
 * A series poster changes what every list showing that series looks like, and the
 * same goes for a collection or a read list, which is why those carry only their
 * own id. A book's poster also changes its series, so the series id comes along.
 */
async function thumbnailEventData(
  db: Kysely<DB>,
  spec: OwnerSpec,
  id: string,
  selected: boolean,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { [spec.idField]: id, selected }
  if (spec.ownerType === 'BOOK') {
    const book = await db.selectFrom('books').select('series_id').where('id', '=', id).executeTakeFirst()
    data.seriesId = book?.series_id ?? ''
  }
  return data
}

/** Whether the owner itself exists, before any question of access. */
async function ownerExists(db: Kysely<DB>, spec: OwnerSpec, id: string): Promise<boolean> {
  const row = await db.selectFrom(OWNER_TABLE[spec.ownerType]).select('id').where('id', '=', id).executeTakeFirst()
  return row !== undefined
}

/**
 * Whether the caller may see the owner.
 *
 * Books and series are checked directly; collections and read lists are global,
 * so they are visible when at least one of their members is.
 */
async function ownerVisible(db: Kysely<DB>, context: ContentContext, spec: OwnerSpec, id: string): Promise<boolean> {
  const allowed = await accessibleSeriesIds(db, context)

  switch (spec.ownerType) {
    case 'BOOK': {
      const row = await db
        .selectFrom('books')
        .select(['library_id', 'series_id'])
        .where('id', '=', id)
        .executeTakeFirst()
      if (!row) return false
      if (!context.libraryIds.includes(row.library_id)) return false
      return allowed === null || allowed.has(row.series_id)
    }
    case 'SERIES': {
      const row = await db.selectFrom('series').select('library_id').where('id', '=', id).executeTakeFirst()
      if (!row) return false
      if (!context.libraryIds.includes(row.library_id)) return false
      return allowed === null || allowed.has(id)
    }
    case 'COLLECTION': {
      if (allowed === null) return true
      const rows = await db
        .selectFrom('collection_series')
        .select('series_id')
        .where('collection_id', '=', id)
        .execute()
      return rows.some((row) => allowed.has(row.series_id))
    }
    case 'READLIST': {
      if (allowed === null) return true
      const rows = await db
        .selectFrom('readlist_book')
        .innerJoin('books', 'books.id', 'readlist_book.book_id')
        .select('books.series_id')
        .where('readlist_id', '=', id)
        .execute()
      return rows.some((row) => allowed.has(row.series_id))
    }
  }
}

/**
 * Send image bytes with the headers a browser needs to cache them.
 *
 * The row's id is part of the tag: replacing a poster writes a new row, so every
 * cache holding the old image is invalidated by the changed tag.
 */
function sendImage(req: FastifyRequest, reply: FastifyReply, record: ThumbnailRecord): FastifyReply {
  const etag = `"${record.id}-"`
  if (req.headers['if-none-match'] === etag) return reply.code(304).send()

  return reply
    .header('etag', etag)
    .header('cache-control', 'public, max-age=86400')
    .type(record.mediaType)
    .send(record.bytes)
}

/**
 * Send an image this server just made - a series' borrowed poster, or a mosaic.
 *
 * Cached briefly and privately: a series shows the poster of a book the caller has
 * not read, so two people looking at one series are not shown the same image.
 */
function sendComputedImage(reply: FastifyReply, image: { bytes: Buffer; mediaType: string }): FastifyReply {
  return reply.header('cache-control', 'private, max-age=60').type(image.mediaType).send(image.bytes)
}

const FORMAT_TO_MEDIA_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  tiff: 'image/tiff',
}

export async function registerThumbnailRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  for (const spec of OWNERS) {
    const base = `/api/v1/${spec.segment}/:${spec.param}`

    /** Resolve the owner for a request, answering 404/403 itself when needed. */
    const resolve = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<{ id: string; context: ContentContext } | undefined> => {
      const id = (req.params as Record<string, string>)[spec.param] ?? ''
      const context = await contentContext(db, req)
      if (!(await ownerExists(db, spec, id))) {
        reply.code(404).send({ message: `${spec.ownerType} not found` })
        return undefined
      }
      if (!(await ownerVisible(db, context, spec, id))) {
        reply.code(403).send({ message: 'Forbidden' })
        return undefined
      }
      return { id, context }
    }

    app.get(`${base}/thumbnail`, { preHandler: requireAuth }, async (req, reply) => {
      const resolved = await resolve(req, reply)
      if (!resolved) return reply

      const stored = await chosenThumbnail(db, spec.ownerType, resolved.id)
      if (stored !== null) return sendImage(req, reply, stored)

      // A series shows the poster of one of its books, and a collection or a read
      // list shows four of its members side by side, which is what the reference
      // does when the owner has no poster of its own.
      if (spec.ownerType === 'SERIES') {
        const borrowed = await seriesCoverThumbnail(db, resolved.id, resolved.context.user.id)
        if (borrowed !== null) return sendImage(req, reply, borrowed)
      }
      if (spec.ownerType === 'COLLECTION') {
        const built = await collectionMosaicThumbnail(db, resolved.id, resolved.context.user.id)
        if (built !== null) return sendComputedImage(reply, built)
      }
      if (spec.ownerType === 'READLIST') {
        const built = await readListMosaicThumbnail(db, resolved.id)
        if (built !== null) return sendComputedImage(reply, built)
      }

      return reply.code(404).send({ message: 'No thumbnail' })
    })

    app.get(`${base}/thumbnails`, { preHandler: requireAuth }, async (req, reply) => {
      const resolved = await resolve(req, reply)
      if (!resolved) return reply

      const rows = await db
        .selectFrom('thumbnails')
        .selectAll()
        .where('owner_type', '=', spec.ownerType)
        .where('owner_id', '=', resolved.id)
        .orderBy('selected', 'desc')
        .orderBy('created_date', 'desc')
        .orderBy('id', 'desc')
        .execute()
      return (rows as unknown as ThumbnailRow[]).map((row) => toThumbnailDto(thumbnailRecord(row), spec))
    })

    app.get(`${base}/thumbnails/:thumbnailId`, { preHandler: requireAuth }, async (req, reply) => {
      const resolved = await resolve(req, reply)
      if (!resolved) return reply

      const { thumbnailId } = req.params as { thumbnailId: string }
      const row = await db
        .selectFrom('thumbnails')
        .selectAll()
        .where('id', '=', thumbnailId)
        .where('owner_type', '=', spec.ownerType)
        .where('owner_id', '=', resolved.id)
        .executeTakeFirst()
      if (!row) return reply.code(404).send({ message: 'Thumbnail not found' })
      return sendImage(req, reply, thumbnailRecord(row as unknown as ThumbnailRow))
    })

    /**
     * Add a poster.
     *
     * The new thumbnail becomes the selected one: the endpoint exists to put a
     * different cover on the item, and leaving the old one selected would look
     * like nothing happened.
     */
    app.post(`${base}/thumbnails`, { preHandler: requireAdmin }, async (req, reply) => {
      const id = (req.params as Record<string, string>)[spec.param] ?? ''
      if (!(await ownerExists(db, spec, id))) {
        return reply.code(404).send({ message: `${spec.ownerType} not found` })
      }
      if (!req.isMultipart()) return reply.code(400).send({ message: 'An image upload is required' })

      const upload = await req.file()
      if (!upload) return reply.code(400).send({ message: 'An image upload is required' })

      const buffer = await upload.toBuffer()
      const metadata = await sharp(buffer)
        .metadata()
        .catch(() => undefined)
      if (!metadata?.format || metadata.format === 'svg') {
        return reply.code(400).send({ message: 'The upload must be a raster image' })
      }

      const detected = await fileTypeFromBuffer(buffer)
      const mediaType = detected?.mime ?? FORMAT_TO_MEDIA_TYPE[metadata.format] ?? 'application/octet-stream'

      const now = new Date().toISOString()
      const thumbnailId = nextTsid()
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('thumbnails')
          .set({ selected: 0, last_modified_date: now })
          .where('owner_type', '=', spec.ownerType)
          .where('owner_id', '=', id)
          .execute()
        await trx
          .insertInto('thumbnails')
          .values({
            id: thumbnailId,
            owner_type: spec.ownerType,
            owner_id: id,
            type: 'USER',
            page: 0,
            selected: 1,
            media_type: mediaType,
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
            file_size: buffer.byteLength,
            thumbnail: buffer,
            created_date: now,
            last_modified_date: now,
          })
          .execute()
      })

      const row = await db.selectFrom('thumbnails').selectAll().where('id', '=', thumbnailId).executeTakeFirstOrThrow()
      opts.events.publish({
        name: `${EVENT_PREFIX[spec.ownerType]}Added`,
        data: await thumbnailEventData(db, spec, id, true),
      })
      return toThumbnailDto(thumbnailRecord(row as unknown as ThumbnailRow), spec)
    })

    app.delete(`${base}/thumbnails/:thumbnailId`, { preHandler: requireAdmin }, async (req, reply) => {
      const id = (req.params as Record<string, string>)[spec.param] ?? ''
      const { thumbnailId } = req.params as { thumbnailId: string }
      if (!(await ownerExists(db, spec, id))) {
        return reply.code(404).send({ message: `${spec.ownerType} not found` })
      }

      const existing = await db
        .selectFrom('thumbnails')
        .select(['id', 'selected'])
        .where('id', '=', thumbnailId)
        .where('owner_type', '=', spec.ownerType)
        .where('owner_id', '=', id)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Thumbnail not found' })

      await db.deleteFrom('thumbnails').where('id', '=', thumbnailId).execute()
      opts.events.publish({
        name: `${EVENT_PREFIX[spec.ownerType]}Deleted`,
        data: await thumbnailEventData(db, spec, id, existing.selected === 1),
      })
      return reply.code(204).send()
    })

    app.put(`${base}/thumbnails/:thumbnailId/selected`, { preHandler: requireAdmin }, async (req, reply) => {
      const id = (req.params as Record<string, string>)[spec.param] ?? ''
      const { thumbnailId } = req.params as { thumbnailId: string }
      if (!(await ownerExists(db, spec, id))) {
        return reply.code(404).send({ message: `${spec.ownerType} not found` })
      }

      const existing = await db
        .selectFrom('thumbnails')
        .select('id')
        .where('id', '=', thumbnailId)
        .where('owner_type', '=', spec.ownerType)
        .where('owner_id', '=', id)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Thumbnail not found' })

      const now = new Date().toISOString()
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('thumbnails')
          .set({ selected: 0 })
          .where('owner_type', '=', spec.ownerType)
          .where('owner_id', '=', id)
          .execute()
        await trx
          .updateTable('thumbnails')
          .set({ selected: 1, last_modified_date: now })
          .where('id', '=', thumbnailId)
          .execute()
      })
      // Selecting a poster changes what every list shows, which is the same
      // thing an upload does, so it is announced the same way.
      opts.events.publish({
        name: `${EVENT_PREFIX[spec.ownerType]}Added`,
        data: await thumbnailEventData(db, spec, id, true),
      })
      return reply.code(204).send()
    })
  }
}
