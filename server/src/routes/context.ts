import type { FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import {
  canAccessLibrary,
  contentRestrictionAllows,
  hasContentRestrictions,
  visibleLibraryIds,
} from '../auth/access.js'
import { allLibraryIds } from '../auth/users.js'
import type { AuthUser } from '../auth/types.js'
import type { DB } from '../db/schema.js'

/** The authenticated user, or a throw if the route forgot its pre-handler. */
export function requireUser(req: FastifyRequest): AuthUser {
  const user = req.user
  if (!user) throw new Error('unauthenticated')
  return user
}

export interface ContentContext {
  user: AuthUser
  /** Libraries the user may see. */
  libraryIds: string[]
  /**
   * Series ids the user may see, or `null` when no content restriction applies.
   *
   * A `null` here is not a shortcut for "allow all" by accident: it is the
   * common case (admins, and users with no age or label rules), and it lets
   * queries skip an id list that could otherwise grow to every series.
   */
  restrictedSeriesIds: string[] | null
}

/** Resolve which libraries and series the caller may see. */
export async function contentContext(db: Kysely<DB>, req: FastifyRequest): Promise<ContentContext> {
  const user = requireUser(req)
  const libraryIds = visibleLibraryIds(user, await allLibraryIds(db))
  if (!hasContentRestrictions(user) || libraryIds.length === 0) {
    return { user, libraryIds, restrictedSeriesIds: hasContentRestrictions(user) ? [] : null }
  }

  const rows = await db
    .selectFrom('series')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'series.id')
    .select(['series.id', 'series_metadata.age_rating'])
    .where('series.library_id', 'in', libraryIds)
    .execute()
  const labels = await db.selectFrom('series_metadata_sharing').select(['series_id', 'label']).execute()

  const labelsBySeries = new Map<string, string[]>()
  for (const row of labels) {
    const list = labelsBySeries.get(row.series_id)
    if (list) list.push(row.label)
    else labelsBySeries.set(row.series_id, [row.label])
  }

  const restrictedSeriesIds = rows
    .filter((row) =>
      contentRestrictionAllows(user, {
        ageRating: row.age_rating,
        sharingLabels: labelsBySeries.get(row.id) ?? [],
      }),
    )
    .map((row) => row.id)

  return { user, libraryIds, restrictedSeriesIds }
}

/**
 * Whether the user may access a series, reporting "not found" and "forbidden"
 * separately so routes can mirror Komga's responses.
 */
export function seriesAllowed(context: ContentContext, seriesId: string, libraryId: string): boolean {
  if (!canAccessLibrary(context.user, libraryId)) return false
  return context.restrictedSeriesIds === null || context.restrictedSeriesIds.includes(seriesId)
}
