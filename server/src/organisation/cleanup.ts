/**
 * Tidying up what a library has emptied.
 *
 * A collection whose series have all been removed, or a read list whose books have,
 * is a set pointing at nothing. The reference deletes those - but only when a
 * library's trash is emptied, and only when the server settings ask for it, which is
 * the same moment here: a collection whose books are still in the trash is a
 * collection whose books are still there.
 */

import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { SETTING_KEYS, getBooleanSetting } from '../settings.js'

/** What the cleanup removed. */
export interface EmptySetCleanup {
  collectionsDeleted: number
  readListsDeleted: number
}

/**
 * The collections that hold nothing.
 *
 * Empty means no member at all, which is what the reference's `findAllEmpty` asks:
 * a collection whose series are still there is not empty, however many of their
 * books have gone.
 */
async function emptyCollections(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .selectFrom('collections')
    .leftJoin('collection_series', 'collection_series.collection_id', 'collections.id')
    .select('collections.id')
    .where('collection_series.collection_id', 'is', null)
    .execute()
  return rows.map((row) => row.id)
}

/** The read lists that hold nothing. */
async function emptyReadLists(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .selectFrom('readlists')
    .leftJoin('readlist_book', 'readlist_book.readlist_id', 'readlists.id')
    .select('readlists.id')
    .where('readlist_book.readlist_id', 'is', null)
    .execute()
  return rows.map((row) => row.id)
}

/** Remove an owner's thumbnails, which no key makes the database do for us. */
async function deleteThumbnails(db: Kysely<DB>, ownerType: 'COLLECTION' | 'READLIST', ids: readonly string[]) {
  await db.deleteFrom('thumbnails').where('owner_type', '=', ownerType).where('owner_id', 'in', ids).execute()
}

/**
 * Delete the collections and read lists that hold nothing, if the settings ask for
 * it. Returns what was removed either way, so a caller can report a clean run.
 */
export async function cleanupEmptySets(db: Kysely<DB>): Promise<EmptySetCleanup> {
  const result: EmptySetCleanup = { collectionsDeleted: 0, readListsDeleted: 0 }

  if (await getBooleanSetting(db, SETTING_KEYS.deleteEmptyCollections, false)) {
    const ids = await emptyCollections(db)
    if (ids.length > 0) {
      await db.transaction().execute(async (trx) => {
        await deleteThumbnails(trx, 'COLLECTION', ids)
        await trx.deleteFrom('collections').where('id', 'in', ids).execute()
      })
      result.collectionsDeleted = ids.length
    }
  }

  if (await getBooleanSetting(db, SETTING_KEYS.deleteEmptyReadLists, false)) {
    const ids = await emptyReadLists(db)
    if (ids.length > 0) {
      await db.transaction().execute(async (trx) => {
        await deleteThumbnails(trx, 'READLIST', ids)
        await trx.deleteFrom('readlists').where('id', 'in', ids).execute()
      })
      result.readListsDeleted = ids.length
    }
  }

  return result
}
