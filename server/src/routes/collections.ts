import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { nextTsid } from '../tsid.js'
import { accessibleSeriesIds, contentContext, type ContentContext } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { toCollectionDto, type CollectionDto, type CollectionRow } from './organisation-dto.js'
import { applySort, booleanParam, likeAny, paging, parseSort, toArray, type SortSpec } from './query.js'
import { filtersFrom, seriesPage, SERIES_DEFAULT_SORT, SERIES_SORTS } from './series.js'

/**
 * Collections: named, ordered groups of series.
 *
 * Collections are global rather than per-user, so access is expressed through
 * their members: a collection is listed when at least one of its series is
 * visible to the caller, and `seriesIds` is trimmed to the visible ones. An
 * empty collection is therefore only visible to an admin.
 */

const COLLECTION_SORTS: Record<string, string> = {
  name: 'collections.name',
  created: 'collections.created_date',
  lastModified: 'collections.last_modified_date',
}

const COLLECTION_DEFAULT_SORT: SortSpec[] = [{ column: 'collections.name', direction: 'asc' }]

const COLLECTION_COLUMNS = [
  'collections.id',
  'collections.name',
  'collections.ordered',
  'collections.created_date',
  'collections.last_modified_date',
] as const

/** Series membership per collection, in stored order. */
async function seriesByCollection(
  db: Kysely<DB>,
  collectionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>()
  if (collectionIds.length === 0) return grouped

  const rows = await db
    .selectFrom('collection_series')
    .select(['collection_id', 'series_id'])
    .where('collection_id', 'in', collectionIds)
    .orderBy('number')
    .execute()

  for (const row of rows) {
    const list = grouped.get(row.collection_id)
    if (list) list.push(row.series_id)
    else grouped.set(row.collection_id, [row.series_id])
  }
  return grouped
}

/** Trim a member list to what the caller may see; `null` allowed means everything. */
function visible(ids: string[], allowed: Set<string> | null): string[] {
  return allowed === null ? ids : ids.filter((id) => allowed.has(id))
}

/** Validate that every referenced series exists. */
async function unknownSeries(db: Kysely<DB>, seriesIds: readonly string[]): Promise<string[]> {
  if (seriesIds.length === 0) return []
  const rows = await db
    .selectFrom('series')
    .select('id')
    .where('id', 'in', seriesIds)
    .execute()
  const known = new Set(rows.map((row) => row.id))
  return seriesIds.filter((id) => !known.has(id))
}

async function replaceMembership(db: Kysely<DB>, collectionId: string, seriesIds: readonly string[]): Promise<void> {
  await db.deleteFrom('collection_series').where('collection_id', '=', collectionId).execute()
  if (seriesIds.length === 0) return
  await db
    .insertInto('collection_series')
    .values(seriesIds.map((seriesId, index) => ({ collection_id: collectionId, series_id: seriesId, number: index })))
    .execute()
}

function readMembers(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.seriesIds)) return null
  const ids = body.seriesIds.map((value) => (typeof value === 'string' ? value.trim() : '')).filter((id) => id !== '')
  return [...new Set(ids)]
}

export async function registerCollectionRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const loadOne = async (
    context: ContentContext,
    id: string,
  ): Promise<{ dto: CollectionDto } | { status: 403 | 404 }> => {
    const row = await db.selectFrom('collections').select(COLLECTION_COLUMNS).where('id', '=', id).executeTakeFirst()
    if (!row) return { status: 404 }

    const grouped = await seriesByCollection(db, [id])
    const allowed = await accessibleSeriesIds(db, context)
    const members = visible(grouped.get(id) ?? [], allowed)
    if (allowed !== null && members.length === 0) return { status: 403 }

    return { dto: toCollectionDto(row as unknown as CollectionRow, members) }
  }

  app.get('/api/v1/collections', { preHandler: requireAuth }, async (req) => {
    const context = await contentContext(db, req)
    const query = (req.query ?? {}) as Record<string, unknown>
    const { page, size } = paging(query)
    const unpaged = booleanParam(query.unpaged) === true
    const libraries = toArray(query.library_id)
    const scoped = libraries.length > 0 ? libraries : context.libraryIds

    let builder = db.selectFrom('collections').select(COLLECTION_COLUMNS)
    if (typeof query.search === 'string' && query.search !== '') {
      builder = builder.where(likeAny('collections.name', query.search))
    }
    if (scoped.length > 0) {
      builder = builder.where((eb) =>
        eb.exists(
          eb
            .selectFrom('collection_series')
            .innerJoin('series', 'series.id', 'collection_series.series_id')
            .select(sql<number>`1`.as('one'))
            .whereRef('collection_series.collection_id', '=', 'collections.id')
            .where('series.library_id', 'in', scoped),
        ),
      )
    }

    const sorts = parseSort(query.sort, COLLECTION_SORTS, COLLECTION_DEFAULT_SORT)
    const rows = await applySort(builder, sorts).orderBy('collections.id').execute()

    const grouped = await seriesByCollection(
      db,
      rows.map((row) => row.id),
    )
    const allowed = await accessibleSeriesIds(db, context)
    const visibleRows = rows
      .map((row) => ({ row, members: visible(grouped.get(row.id) ?? [], allowed) }))
      .filter((entry) => allowed === null || entry.members.length > 0)

    const total = visibleRows.length
    const window = unpaged ? visibleRows : visibleRows.slice(page * size, page * size + size)
    const content = window.map((entry) => toCollectionDto(entry.row as unknown as CollectionRow, entry.members))

    return springPage(content, page, unpaged ? total : size, total)
  })

  app.post('/api/v1/collections', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') return reply.code(400).send({ validationErrors: { name: 'must not be blank' } })

    const seriesIds = readMembers(body) ?? []
    const missing = await unknownSeries(db, seriesIds)
    if (missing.length > 0) {
      return reply.code(400).send({ validationErrors: { seriesIds: `unknown series: ${missing.join(', ')}` } })
    }

    const now = new Date().toISOString()
    const id = nextTsid()
    await db
      .insertInto('collections')
      .values({
        id,
        name,
        ordered: body.ordered === false ? 0 : 1,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    await replaceMembership(db, id, seriesIds)

    const row = await db.selectFrom('collections').select(COLLECTION_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow()
    return toCollectionDto(row as unknown as CollectionRow, seriesIds)
  })

  app.get<{ Params: { id: string } }>('/api/v1/collections/:id', { preHandler: requireAuth }, async (req, reply) => {
    const context = await contentContext(db, req)
    const found = await loadOne(context, req.params.id)
    if ('status' in found) {
      return reply.code(found.status).send({ message: found.status === 404 ? 'Collection not found' : 'Forbidden' })
    }
    return found.dto
  })

  app.patch<{ Params: { id: string } }>('/api/v1/collections/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await db
      .selectFrom('collections')
      .select('id')
      .where('id', '=', req.params.id)
      .executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'Collection not found' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const values: Record<string, unknown> = { last_modified_date: new Date().toISOString() }

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return reply.code(400).send({ validationErrors: { name: 'must not be blank' } })
      values.name = name
    }
    if ('ordered' in body) {
      if (typeof body.ordered !== 'boolean') {
        return reply.code(400).send({ validationErrors: { ordered: 'must be a boolean' } })
      }
      values.ordered = body.ordered ? 1 : 0
    }

    const members = readMembers(body)
    if (members !== null) {
      const missing = await unknownSeries(db, members)
      if (missing.length > 0) {
        return reply.code(400).send({ validationErrors: { seriesIds: `unknown series: ${missing.join(', ')}` } })
      }
    }

    await db
      .updateTable('collections')
      .set(values as never)
      .where('id', '=', req.params.id)
      .execute()
    if (members !== null) await replaceMembership(db, req.params.id, members)
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>(
    '/api/v1/collections/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('collections')
        .select('id')
        .where('id', '=', req.params.id)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Collection not found' })

      await db.deleteFrom('collections').where('id', '=', req.params.id).execute()
      return reply.code(204).send()
    },
  )

  /** The series in a collection, with the same filters as `/series`. */
  app.get<{ Params: { id: string } }>(
    '/api/v1/collections/:id/series',
    { preHandler: requireAuth },
    async (req, reply) => {
      const context = await contentContext(db, req)
      const found = await loadOne(context, req.params.id)
      if ('status' in found) {
        return reply.code(found.status).send({ message: found.status === 404 ? 'Collection not found' : 'Forbidden' })
      }

      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, size } = paging(query)
      const unpaged = booleanParam(query.unpaged) === true
      const filters = filtersFrom(context, query)
      filters.collectionIds = [req.params.id]

      return seriesPage(
        db,
        context,
        filters,
        parseSort(query.sort, SERIES_SORTS, SERIES_DEFAULT_SORT),
        page,
        size,
        unpaged,
      )
    },
  )
}
