import type { Kysely } from 'kysely'
import type { DB } from './db/schema.js'

/** Server-level key/value settings (`server_settings` table). */
export async function getSetting(db: Kysely<DB>, key: string): Promise<string | undefined> {
  const row = await db.selectFrom('server_settings').select('value').where('key', '=', key).executeTakeFirst()
  return row?.value
}

export async function setSetting(db: Kysely<DB>, key: string, value: string): Promise<void> {
  await db
    .insertInto('server_settings')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute()
}

/** Read a setting, generating and persisting it on first use. */
export async function getOrCreateSetting(db: Kysely<DB>, key: string, generate: () => string): Promise<string> {
  const existing = await getSetting(db, key)
  if (existing !== undefined) return existing
  const value = generate()
  await setSetting(db, key, value)
  return value
}

/** Drop a setting, so readers fall back to their default. */
export async function deleteSetting(db: Kysely<DB>, key: string): Promise<void> {
  await db.deleteFrom('server_settings').where('key', '=', key).execute()
}

/**
 * The settings the admin API exposes.
 *
 * The stored names are the ones the reference implementation uses, so a
 * database carried over from it keeps its values.
 */
export const SETTING_KEYS = {
  deleteEmptyCollections: 'DELETE_EMPTY_COLLECTIONS',
  deleteEmptyReadLists: 'DELETE_EMPTY_READLISTS',
  rememberMeDurationDays: 'REMEMBER_ME_DURATION',
  thumbnailSize: 'THUMBNAIL_SIZE',
  taskPoolSize: 'TASK_POOL_SIZE',
  serverPort: 'SERVER_PORT',
  koboProxy: 'KOBO_PROXY',
  koboPort: 'KOBO_PORT',
  kepubifyPath: 'KEPUBIFY_PATH',
} as const

/** Default lifetime of a remember-me cookie, in days. */
export const DEFAULT_REMEMBER_ME_DURATION_DAYS = 365

async function storedValue(db: Kysely<DB>, key: string): Promise<string | undefined> {
  const row = await db.selectFrom('server_settings').select('value').where('key', '=', key).executeTakeFirst()
  return row?.value === '' ? undefined : row?.value
}

/** A stored boolean, or `fallback` when unset or unparseable. */
export async function getBooleanSetting(db: Kysely<DB>, key: string, fallback: boolean): Promise<boolean> {
  const value = await storedValue(db, key)
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** A stored integer, or `fallback` when unset or unparseable. */
export async function getIntSetting(db: Kysely<DB>, key: string, fallback: number): Promise<number> {
  const value = await storedValue(db, key)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** How long a remember-me cookie lives, using the stored setting when set. */
export async function getRememberMeDurationDays(db: Kysely<DB>): Promise<number> {
  const days = await getIntSetting(db, SETTING_KEYS.rememberMeDurationDays, DEFAULT_REMEMBER_ME_DURATION_DAYS)
  return days >= 1 ? days : DEFAULT_REMEMBER_ME_DURATION_DAYS
}
