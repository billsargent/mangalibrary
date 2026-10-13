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
import { toArray } from './query.js'

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

/** What was worked out for one set of rules, and the state of the library it was worked out from. */
interface Remembered {
  version: number
  seriesIds: string[]
}

/**
 * What restricted users may see, per database, by the rules that decide it.
 *
 * Keyed by the rules and not the user: two users with the same restriction see
 * the same series. Bounded, so a server with many differently restricted users
 * does not keep a list for each for ever.
 */
const remembered = new WeakMap<Kysely<DB>, Map<string, Remembered>>()
const REMEMBERED_RULES = 64

const sets = new WeakMap<readonly string[], Set<string>>()

/**
 * The series a restricted user may see, as a set, or `null` for every series.
 *
 * Made once for a list and kept with it: the same list answers request after
 * request, and a membership test is asked for every item of a listing.
 */
export function allowedSeries(context: ContentContext): ReadonlySet<string> | null {
  const ids = context.restrictedSeriesIds
  if (ids === null) return null
  let set = sets.get(ids)
  if (set === undefined) {
    set = new Set(ids)
    sets.set(ids, set)
  }
  return set
}

/** The count that moves when a series' library, age rating or labels change. */
async function contentVersion(db: Kysely<DB>): Promise<number | null> {
  try {
    const row = await db.selectFrom('content_version').select('version').where('id', '=', 1).executeTakeFirst()
    return row?.version ?? null
  } catch {
    // A database from before the counter has nothing to compare with, so nothing is kept.
    return null
  }
}

/** Resolve which libraries and series the caller may see. */
export async function contentContext(db: Kysely<DB>, req: FastifyRequest): Promise<ContentContext> {
  const user = requireUser(req)
  const libraryIds = visibleLibraryIds(user, await allLibraryIds(db))
  if (!hasContentRestrictions(user) || libraryIds.length === 0) {
    return { user, libraryIds, restrictedSeriesIds: hasContentRestrictions(user) ? [] : null }
  }

  // Working this out reads every series and every label, and a request for one
  // page of a book asks for it. It is kept until something it depends on changes.
  const version = await contentVersion(db)
  const rules = JSON.stringify([user.restrictions, [...libraryIds].sort()])
  let known = remembered.get(db)
  if (known === undefined) {
    known = new Map()
    remembered.set(db, known)
  }
  const kept = known.get(rules)
  if (version !== null && kept?.version === version) {
    return { user, libraryIds, restrictedSeriesIds: kept.seriesIds }
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

  if (version !== null) {
    if (known.size >= REMEMBERED_RULES) known.clear()
    known.set(rules, { version, seriesIds: restrictedSeriesIds })
  }
  return { user, libraryIds, restrictedSeriesIds }
}

/**
 * Whether the user may access a series, reporting "not found" and "forbidden"
 * separately so routes can mirror Komga's responses.
 */
export function seriesAllowed(context: ContentContext, seriesId: string, libraryId: string): boolean {
  if (!canAccessLibrary(context.user, libraryId)) return false
  return allowedSeries(context)?.has(seriesId) ?? true
}

/**
 * The libraries a listing covers: the ones the request names, narrowed to the ones
 * the caller may see.
 *
 * `library_id` is a filter, and a filter can only take away. Naming a library that
 * is not shared with the caller therefore leaves nothing, which is also what the
 * caller is told about a library that does not exist - the two must not be
 * distinguishable by asking.
 */
export function scopedLibraryIds(context: ContentContext, requested: unknown): string[] {
  const asked = toArray(requested)
  if (asked.length === 0) return context.libraryIds
  const allowed = new Set(context.libraryIds)
  return asked.filter((id) => allowed.has(id))
}

/**
 * Series ids the user may see, or `null` when that means every series.
 *
 * Used by the organisation endpoints: a collection or read list is listed when
 * at least one of its members is visible, and its member list is trimmed to what
 * the caller can see.
 */
export async function accessibleSeriesIds(db: Kysely<DB>, context: ContentContext): Promise<Set<string> | null> {
  const restricted = allowedSeries(context)
  if (restricted !== null) return new Set(restricted)

  const all = await allLibraryIds(db)
  if (context.libraryIds.length === all.length) return null

  const rows = await db.selectFrom('series').select('id').where('library_id', 'in', context.libraryIds).execute()
  return new Set(rows.map((row) => row.id))
}
