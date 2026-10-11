import { type Kysely } from 'kysely'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { requireAdmin, requireAuth } from '../auth/session.js'
import type { DB, ThumbnailOwnerType } from '../db/schema.js'
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

interface ThumbnailRow {
  id: string
  owner_type: string
  owner_id: string
  type: string
  page: number
  selected: number
  media_type: string
  width: number
  height: number
  file_size: number
  thumbnail: Buffer
  created_date: string
  last_modified_date: string
}

/** DTO shape is the same for every owner, with one renamed id field. */
function toThumbnailDto(row: ThumbnailRow, spec: OwnerSpec): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    selected: row.selected === 1,
    mediaType: row.media_type,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    [spec.idField]: row.owner_id,
  }
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

/** The thumbnail to serve for an owner: the selected one, else the newest. */
async function chosenThumbnail(db: Kysely<DB>, spec: OwnerSpec, id: string): Promise<ThumbnailRow | undefined> {
  const row = await db
    .selectFrom('thumbnails')
    .selectAll()
    .where('owner_type', '=', spec.ownerType)
    .where('owner_id', '=', id)
    .orderBy('selected', 'desc')
    .orderBy('created_date', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row as ThumbnailRow | undefined
}

/**
 * Send image bytes with the headers a browser needs to cache them.
 *
 * `last_modified_date` is part of the tag, so replacing a poster invalidates
 * every cache that holds the old one.
 */
function sendImage(req: FastifyRequest, reply: FastifyReply, row: ThumbnailRow): FastifyReply {
  const etag = `"${row.id}-${Date.parse(row.last_modified_date) || 0}"`
  if (req.headers['if-none-match'] === etag) return reply.code(304).send()

  return reply
    .header('etag', etag)
    .header('cache-control', 'public, max-age=86400')
    .type(row.media_type)
    .send(row.thumbnail)
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

      const row = await chosenThumbnail(db, spec, resolved.id)
      if (!row) return reply.code(404).send({ message: 'No thumbnail' })
      return sendImage(req, reply, row)
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
      return (rows as ThumbnailRow[]).map((row) => toThumbnailDto(row, spec))
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
      return sendImage(req, reply, row as ThumbnailRow)
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
      return toThumbnailDto(row as ThumbnailRow, spec)
    })

    app.delete(`${base}/thumbnails/:thumbnailId`, { preHandler: requireAdmin }, async (req, reply) => {
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

      await db.deleteFrom('thumbnails').where('id', '=', thumbnailId).execute()
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
      return reply.code(204).send()
    })
  }
}
