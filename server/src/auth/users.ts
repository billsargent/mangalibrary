import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { isUserRole, type AuthUser, type ContentRestrictions, type UserRole } from './types.js'

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function toRoles(json: string): UserRole[] {
  return parseStringArray(json).filter(isUserRole)
}

export async function findUserById(db: Kysely<DB>, id: string): Promise<AuthUser | undefined> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) return undefined

  const [librarySharing, labelSharing] = await Promise.all([
    db.selectFrom('user_library_sharing').select('library_id').where('user_id', '=', id).execute(),
    db.selectFrom('user_sharing').select(['allow', 'label']).where('user_id', '=', id).execute(),
  ])

  const labelsAllow = labelSharing.filter((entry) => entry.allow === 1).map((entry) => entry.label)
  const labelsExclude = labelSharing.filter((entry) => entry.allow !== 1).map((entry) => entry.label)

  const restrictions: ContentRestrictions = {
    ageRestriction:
      row.age_restriction === null
        ? null
        : { age: row.age_restriction, restriction: row.age_restriction_allow_only === 0 ? 'EXCLUDE' : 'ALLOW_ONLY' },
    // A label cannot be both allowed and excluded; exclusion wins.
    labelsAllow: labelsAllow.filter((label) => !labelsExclude.includes(label)),
    labelsExclude,
  }

  return {
    id: row.id,
    email: row.email,
    roles: toRoles(row.roles),
    sharedAllLibraries: row.shared_all_libraries === 1,
    sharedLibraryIds: librarySharing.map((entry) => entry.library_id),
    restrictions,
  }
}

export async function findUserByEmail(db: Kysely<DB>, email: string): Promise<AuthUser | undefined> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where(sql<boolean>`lower(email) = ${email.trim().toLowerCase()}`)
    .executeTakeFirst()
  return row ? findUserById(db, row.id) : undefined
}

export async function getPasswordHash(db: Kysely<DB>, userId: string): Promise<string | undefined> {
  const row = await db.selectFrom('users').select('password').where('id', '=', userId).executeTakeFirst()
  return row?.password
}

export async function setPasswordHash(db: Kysely<DB>, userId: string, hash: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ password: hash, last_modified_date: new Date().toISOString() })
    .where('id', '=', userId)
    .execute()
}

export interface ApiKeyOwner {
  user: AuthUser
  apiKeyId: string
}

/**
 * What is stored for an API key: the hex SHA-512 of it, as the reference stores it.
 *
 * A key is shown once, when it is made, and only this is kept, so a copy of the
 * database does not hand out working keys - and a key carried over from the
 * reference's database works here unchanged.
 */
export function hashApiKey(key: string): string {
  return createHash('sha512').update(key.trim(), 'utf8').digest('hex')
}

export async function findUserByApiKey(db: Kysely<DB>, key: string): Promise<ApiKeyOwner | undefined> {
  if (key.trim() === '') return undefined
  const row = await db
    .selectFrom('user_api_keys')
    .select(['id', 'user_id'])
    .where('key', '=', hashApiKey(key))
    .executeTakeFirst()
  if (!row) return undefined
  const user = await findUserById(db, row.user_id)
  return user ? { user, apiKeyId: row.id } : undefined
}

/** All library ids, used to expand "all libraries" access. */
export async function allLibraryIds(db: Kysely<DB>): Promise<string[]> {
  const rows = await db.selectFrom('libraries').select('id').execute()
  return rows.map((row) => row.id)
}
