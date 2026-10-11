import { sql, type Kysely } from 'kysely'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { visibleLibraryIds } from '../auth/access.js'
import { allLibraryIds } from '../auth/users.js'
import { requireAuth } from '../auth/session.js'
import type { DB } from '../db/schema.js'
import { springPage, type SpringPage } from './dto.js'
import type { RouteOptions } from './libraries.js'

interface AuthorDto {
  name: string
  role: string
}

interface PageParams {
  page?: number
  size?: number
  unpaged?: boolean
}

function pageParams(query: unknown): { page: number; size: number; paged: boolean } {
  const params = (query ?? {}) as PageParams
  const page = Number.isFinite(params.page) ? Number(params.page) : 0
  const size = Number.isFinite(params.size) ? Number(params.size) : 20
  return { page, size, paged: params.unpaged !== true }
}

/** Either a plain array (v1) or a Spring page (v2). */
function paginated<T>(items: T[], query: unknown, usePage: boolean): T[] | SpringPage<T> {
  if (!usePage) return items
  const { page, size } = pageParams(query)
  return springPage(items.slice(page * size, page * size + size), page, size, items.length)
}

async function seriesIdsFor(db: Kysely<DB>, req: FastifyRequest): Promise<string[]> {
  const user = req.user
  if (!user) return []
  const libraryIds = visibleLibraryIds(user, await allLibraryIds(db))
  if (libraryIds.length === 0) return []
  const rows = await db.selectFrom('series').select('id').where('library_id', 'in', libraryIds).execute()
  return rows.map((row) => row.id)
}

async function distinctStrings(rows: { value: string | null }[]): Promise<string[]> {
  const seen = new Set<string>()
  for (const row of rows) {
    const value = row.value?.trim()
    if (value) seen.add(value)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export async function registerReferentialRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const register = (paths: string[], usePage: boolean) => {
    for (const path of paths) {
      // Authors -----------------------------------------------------------------
      app.get(`${path}/authors`, { preHandler: requireAuth }, async (req) => {
        const query = (req.query ?? {}) as { role?: string; search?: string }
        const seriesIds = await seriesIdsFor(db, req)
        if (seriesIds.length === 0) return paginated<AuthorDto>([], req.query, usePage)

        const seriesAuthors = await db
          .selectFrom('series_metadata_author')
          .select(['name', 'role'])
          .where('series_id', 'in', seriesIds)
          .execute()
        const bookAuthors = await db
          .selectFrom('book_metadata_author')
          .select(['name', 'role'])
          .where(
            'book_id',
            'in',
            db.selectFrom('books').select('id').where('series_id', 'in', seriesIds),
          )
          .execute()

        const unique = new Map<string, AuthorDto>()
        for (const author of [...seriesAuthors, ...bookAuthors]) {
          if (query.role && author.role !== query.role) continue
          if (query.search && !author.name.toLowerCase().includes(query.search.toLowerCase())) continue
          unique.set(`${author.name}\u0000${author.role}`, { name: author.name, role: author.role })
        }
        const authors = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role))
        return paginated(authors, req.query, usePage)
      })

      app.get(`${path}/authors/names`, { preHandler: requireAuth }, async (req) => {
        const seriesIds = await seriesIdsFor(db, req)
        if (seriesIds.length === 0) return paginated<string>([], req.query, usePage)
        const rows = await db
          .selectFrom('series_metadata_author')
          .select('name as value')
          .where('series_id', 'in', seriesIds)
          .union(db.selectFrom('book_metadata_author').select('name as value'))
          .execute()
        return paginated(await distinctStrings(rows), req.query, usePage)
      })

      app.get(`${path}/authors/roles`, { preHandler: requireAuth }, async (req) => {
        const seriesIds = await seriesIdsFor(db, req)
        if (seriesIds.length === 0) return paginated<string>([], req.query, usePage)
        const rows = await db
          .selectFrom('series_metadata_author')
          .select('role as value')
          .where('series_id', 'in', seriesIds)
          .union(db.selectFrom('book_metadata_author').select('role as value'))
          .execute()
        return paginated(await distinctStrings(rows), req.query, usePage)
      })

      // Simple string referentials -------------------------------------------------
      const simple = async (
        request: FastifyRequest,
        column: 'tag' | 'genre' | null,
        table: 'series_metadata_tag' | 'series_metadata_genre' | 'series_metadata_sharing',
      ) => {
        const seriesIds = await seriesIdsFor(db, request)
        if (seriesIds.length === 0) return paginated<string>([], request.query, usePage)
        const rows = await db
          .selectFrom(table)
          .select(column ? (`${column} as value` as const) : ('label as value' as const))
          .distinct()
          .where('series_id', 'in', seriesIds)
          .execute()
        return paginated(await distinctStrings(rows as { value: string | null }[]), request.query, usePage)
      }

      app.get(`${path}/genres`, { preHandler: requireAuth }, async (req) => simple(req, 'genre', 'series_metadata_genre'))
      app.get(`${path}/tags`, { preHandler: requireAuth }, async (req) => simple(req, 'tag', 'series_metadata_tag'))
      app.get(`${path}/tags/series`, { preHandler: requireAuth }, async (req) => simple(req, 'tag', 'series_metadata_tag'))
      app.get(`${path}/sharing-labels`, { preHandler: requireAuth }, async (req) => simple(req, null, 'series_metadata_sharing'))

      app.get(`${path}/tags/book`, { preHandler: requireAuth }, async (req) => {
        const seriesIds = await seriesIdsFor(db, req)
        if (seriesIds.length === 0) return paginated<string>([], req.query, usePage)
        const rows = await db
          .selectFrom('book_metadata_tag')
          .select('tag as value')
          .distinct()
          .where(
            'book_id',
            'in',
            db.selectFrom('books').select('id').where('series_id', 'in', seriesIds),
          )
          .execute()
        return paginated(await distinctStrings(rows), req.query, usePage)
      })

      // Metadata columns -----------------------------------------------------------
      const fromMetadata = async (request: FastifyRequest, column: 'publisher' | 'language') => {
        const seriesIds = await seriesIdsFor(db, request)
        if (seriesIds.length === 0) return paginated<string>([], request.query, usePage)
        const rows = await db
          .selectFrom('series_metadata')
          .select(`${column} as value`)
          .distinct()
          .where('series_id', 'in', seriesIds)
          .where(column, '!=', '')
          .execute()
        return paginated(await distinctStrings(rows as { value: string | null }[]), request.query, usePage)
      }

      app.get(`${path}/publishers`, { preHandler: requireAuth }, async (req) => fromMetadata(req, 'publisher'))
      app.get(`${path}/languages`, { preHandler: requireAuth }, async (req) => fromMetadata(req, 'language'))

      // Age ratings ----------------------------------------------------------------
      app.get(`${path}/age-ratings`, { preHandler: requireAuth }, async (req) => {
        const seriesIds = await seriesIdsFor(db, req)
        if (seriesIds.length === 0) return paginated<string>([], req.query, usePage)
        const rows = await db
          .selectFrom('series_metadata')
          .select(sql<string>`cast(age_rating as text)`.as('value'))
          .distinct()
          .where('series_id', 'in', seriesIds)
          .where('age_rating', 'is not', null)
          .execute()
        const values = await distinctStrings(rows)
        return paginated(
          values.sort((a, b) => Number(a) - Number(b)),
          req.query,
          usePage,
        )
      })
    }
  }

  register(['/api/v1'], false)
  register(['/api/v2'], true)
}
