import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { isUserRole, type AuthUser, type UserRole } from './types.js'

export function hasRole(user: AuthUser, role: UserRole): boolean {
  return isUserRole(role) && user.roles.includes(role)
}

export function isAdmin(user: AuthUser): boolean {
  return hasRole(user, 'ADMIN')
}

/** The roles a stored JSON array holds, ignoring anything unreadable. */
function rolesOf(stored: string): UserRole[] {
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter(isUserRole) : []
  } catch {
    // A column that cannot be parsed grants nothing, rather than failing a request.
    return []
  }
}

/**
 * Whether an account is the only one that can administer the server.
 *
 * The roles are stored as a JSON array in a text column, so they are read here
 * rather than counted in SQL: an instance has as many rows as it has people.
 */
export async function isLastAdministrator(db: Kysely<DB>, userId: string): Promise<boolean> {
  const rows = await db.selectFrom('users').select(['id', 'roles']).execute()
  const administrators = rows.filter((row) => rolesOf(row.roles).includes('ADMIN'))
  return administrators.length === 1 && administrators[0]?.id === userId
}

export function canAccessLibrary(user: AuthUser, libraryId: string): boolean {
  return isAdmin(user) || user.sharedAllLibraries || user.sharedLibraryIds.includes(libraryId)
}

/** Library ids visible to the user (admins and "all libraries" users see everything). */
export function visibleLibraryIds(user: AuthUser, allLibraryIds: readonly string[]): string[] {
  if (isAdmin(user) || user.sharedAllLibraries) return [...allLibraryIds]
  return allLibraryIds.filter((id) => user.sharedLibraryIds.includes(id))
}

export interface SeriesRestrictions {
  ageRating: number | null
  sharingLabels: string[]
}

function lower(values: readonly string[]): string[] {
  return values.filter((value) => value.trim() !== '').map((value) => value.trim().toLowerCase())
}

/**
 * Whether any content restriction applies. When this is false every series is
 * visible, which lets callers skip building an id list entirely.
 */
export function hasContentRestrictions(user: AuthUser): boolean {
  if (isAdmin(user)) return false
  const { ageRestriction, labelsAllow, labelsExclude } = user.restrictions
  return ageRestriction !== null || labelsAllow.length > 0 || labelsExclude.length > 0
}

/** Combine conditions where `null` means "no constraint" (jOOQ's `noCondition`). */
function orCondition(left: boolean | null, right: boolean | null): boolean | null {
  if (left === null) return right
  if (right === null) return left
  return left || right
}

function andCondition(left: boolean | null, right: boolean | null): boolean | null {
  if (left === null) return right
  if (right === null) return left
  return left && right
}

/**
 * Whether the user may see a series, matching Komga:
 * `(ageAllowed || labelAllowed) && ageDenied && labelDenied`, where a rule that
 * is absent imposes no constraint at all (it is not a "true" operand).
 */
export function contentRestrictionAllows(user: AuthUser, series: SeriesRestrictions): boolean {
  if (isAdmin(user)) return true

  const { ageRestriction, labelsAllow, labelsExclude } = user.restrictions
  const seriesLabels = lower(series.sharingLabels)
  const allow = lower(labelsAllow)
  const exclude = lower(labelsExclude)

  const ageAllowed =
    ageRestriction?.restriction === 'ALLOW_ONLY'
      ? series.ageRating !== null && series.ageRating <= ageRestriction.age
      : null
  const labelAllowed = allow.length > 0 ? allow.some((label) => seriesLabels.includes(label)) : null
  const ageDenied =
    ageRestriction?.restriction === 'EXCLUDE'
      ? series.ageRating === null || series.ageRating < ageRestriction.age
      : null
  const labelDenied = exclude.length > 0 ? !exclude.some((label) => seriesLabels.includes(label)) : null

  const allowed = orCondition(ageAllowed, labelAllowed)
  const denied = andCondition(ageDenied, labelDenied)
  return andCondition(allowed, denied) ?? true
}
