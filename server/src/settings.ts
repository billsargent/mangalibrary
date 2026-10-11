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
