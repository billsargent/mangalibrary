import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { SETTING_KEYS, setSetting } from '../settings.js'
import { cleanupEmptySets } from './cleanup.js'

/**
 * A library holding one series with one book, one collection that holds that series,
 * one collection that holds nothing, one read list with that book, and one read list
 * with nothing.
 */
async function setup(): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()
  const db = database.db

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'Akira',
      url: 'Akira',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    })
    .execute()
  await db
    .insertInto('books')
    .values({
      id: 'B1',
      series_id: 'S1',
      library_id: 'L1',
      name: 'Volume 1',
      url: 'Akira/Volume 1.cbz',
      file_last_modified: now,
      file_size: 0,
      number: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  await db
    .insertInto('collections')
    .values([
      { id: 'HOLDING', name: 'Holding', created_date: now, last_modified_date: now },
      { id: 'EMPTY', name: 'Empty', created_date: now, last_modified_date: now },
    ])
    .execute()
  await db.insertInto('collection_series').values({ collection_id: 'HOLDING', series_id: 'S1', number: 0 }).execute()

  await db
    .insertInto('readlists')
    .values([
      { id: 'HOLDING', name: 'Holding', created_date: now, last_modified_date: now },
      { id: 'EMPTY', name: 'Empty', created_date: now, last_modified_date: now },
    ])
    .execute()
  await db.insertInto('readlist_book').values({ readlist_id: 'HOLDING', book_id: 'B1', number: 0 }).execute()

  // A poster on each of the two empty ones, which is removed with them.
  await db
    .insertInto('thumbnails')
    .values(
      (['COLLECTION', 'READLIST'] as const).map((ownerType) => ({
        id: `T-${ownerType}`,
        owner_type: ownerType,
        owner_id: 'EMPTY',
        type: 'USER',
        page: 0,
        selected: 1,
        media_type: 'image/png',
        width: 4,
        height: 6,
        file_size: 10,
        thumbnail: Buffer.from('a poster'),
        url: null,
        created_date: now,
        last_modified_date: now,
      })),
    )
    .execute()

  return database
}

/** The ids of the collections still stored. */
async function collections(database: Database): Promise<string[]> {
  const rows = await database.db.selectFrom('collections').select('id').orderBy('id').execute()
  return rows.map((row) => row.id)
}

/** The ids of the read lists still stored. */
async function readLists(database: Database): Promise<string[]> {
  const rows = await database.db.selectFrom('readlists').select('id').orderBy('id').execute()
  return rows.map((row) => row.id)
}

describe('removing what a library has emptied', () => {
  it('does nothing when the settings are off, which is the default', async () => {
    const database = await setup()

    expect(await cleanupEmptySets(database.db)).toEqual({ collectionsDeleted: 0, readListsDeleted: 0 })
    expect(await collections(database)).toEqual(['EMPTY', 'HOLDING'])
    expect(await readLists(database)).toEqual(['EMPTY', 'HOLDING'])

    await database.close()
  })

  it('removes an empty collection and an empty read list when the settings ask for it', async () => {
    const database = await setup()
    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')
    await setSetting(database.db, SETTING_KEYS.deleteEmptyReadLists, 'true')

    expect(await cleanupEmptySets(database.db)).toEqual({ collectionsDeleted: 1, readListsDeleted: 1 })
    // What still holds something stays.
    expect(await collections(database)).toEqual(['HOLDING'])
    expect(await readLists(database)).toEqual(['HOLDING'])

    // And the poster of a removed one goes with it.
    const thumbnails = await database.db.selectFrom('thumbnails').select('id').execute()
    expect(thumbnails).toHaveLength(0)

    await database.close()
  })

  it('leaves the one kind alone when only the other is asked for', async () => {
    const database = await setup()
    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')

    expect(await cleanupEmptySets(database.db)).toEqual({ collectionsDeleted: 1, readListsDeleted: 0 })
    expect(await collections(database)).toEqual(['HOLDING'])
    expect(await readLists(database)).toEqual(['EMPTY', 'HOLDING'])

    await database.close()
  })

  it('finds nothing to remove a second time', async () => {
    const database = await setup()
    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')
    await setSetting(database.db, SETTING_KEYS.deleteEmptyReadLists, 'true')

    await cleanupEmptySets(database.db)
    expect(await cleanupEmptySets(database.db)).toEqual({ collectionsDeleted: 0, readListsDeleted: 0 })

    await database.close()
  })

  it('treats a collection whose series is still there, but whose books have gone, as holding something', async () => {
    const database = await setup()
    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')

    // The book is deleted for good, which is what a scan's trash-emptying does; its
    // series stays, so the collection that holds the series stays with it.
    await database.db.deleteFrom('books').where('id', '=', 'B1').execute()

    expect((await cleanupEmptySets(database.db)).collectionsDeleted).toBe(1)
    expect(await collections(database)).toEqual(['HOLDING'])

    // The read list, though, has lost the only book it held.
    await setSetting(database.db, SETTING_KEYS.deleteEmptyReadLists, 'true')
    expect((await cleanupEmptySets(database.db)).readListsDeleted).toBe(2)
    expect(await readLists(database)).toEqual([])

    await database.close()
  })

  it('removes a collection as soon as its last series is deleted', async () => {
    const database = await setup()
    await setSetting(database.db, SETTING_KEYS.deleteEmptyCollections, 'true')

    // Deleting the series takes its membership with it, through the key.
    await database.db.deleteFrom('series').where('id', '=', 'S1').execute()

    expect((await cleanupEmptySets(database.db)).collectionsDeleted).toBe(2)
    expect(await collections(database)).toEqual([])

    await database.close()
  })
})
