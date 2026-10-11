import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { addBookToReadList, addSeriesToCollection } from './membership.js'

async function setup(): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/library', created_date: now, last_modified_date: now })
    .execute()
  await database.db
    .insertInto('series')
    .values([
      {
        id: 'S1',
        library_id: 'L1',
        name: 'Akira',
        url: 'akira',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S2',
        library_id: 'L1',
        name: 'Domu',
        url: 'domu',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()
  await database.db
    .insertInto('books')
    .values([
      {
        id: 'B1',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'akira/1.cbz',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B2',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 2',
        url: 'akira/2.cbz',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  return database
}

async function members(database: Database, collectionId: string) {
  return database.db
    .selectFrom('collection_series')
    .select(['series_id', 'number'])
    .where('collection_id', '=', collectionId)
    .orderBy('number')
    .execute()
}

async function readListMembers(database: Database, readListId: string) {
  return database.db
    .selectFrom('readlist_book')
    .select(['book_id', 'number'])
    .where('readlist_id', '=', readListId)
    .orderBy('number')
    .execute()
}

describe('putting a series in a collection', () => {
  it('creates the collection when it is not there', async () => {
    const database = await setup()

    expect(await addSeriesToCollection(database.db, 'Otomo', 'S1')).toBe('created')
    const collections = await database.db.selectFrom('collections').selectAll().execute()
    expect(collections).toHaveLength(1)
    expect(collections[0]?.name).toBe('Otomo')
    expect(await members(database, collections[0]!.id)).toEqual([{ series_id: 'S1', number: 0 }])
  })

  it('adds to a collection that already exists, at the end', async () => {
    const database = await setup()
    await addSeriesToCollection(database.db, 'Otomo', 'S1')

    expect(await addSeriesToCollection(database.db, 'Otomo', 'S2')).toBe('added')
    const collections = await database.db.selectFrom('collections').select(['id']).execute()
    expect(await members(database, collections[0]!.id)).toEqual([
      { series_id: 'S1', number: 0 },
      { series_id: 'S2', number: 1 },
    ])
  })

  it('leaves a series that is already in it where it is', async () => {
    const database = await setup()
    await addSeriesToCollection(database.db, 'Otomo', 'S1')

    expect(await addSeriesToCollection(database.db, 'Otomo', 'S1')).toBe('present')
    const collections = await database.db.selectFrom('collections').select(['id']).execute()
    expect(await members(database, collections[0]!.id)).toHaveLength(1)
  })

  it('matches a collection by name, so a name in a different case is another one', async () => {
    const database = await setup()
    await addSeriesToCollection(database.db, 'Otomo', 'S1')
    await addSeriesToCollection(database.db, 'otomo', 'S2')

    const collections = await database.db.selectFrom('collections').selectAll().orderBy('name').execute()
    expect(collections.map((row) => row.name)).toEqual(['Otomo', 'otomo'])
  })
})

describe('putting a book in a read list', () => {
  it('creates the read list when it is not there, with the book at its stated place', async () => {
    const database = await setup()

    expect(await addBookToReadList(database.db, 'The Long Way', 'B1', 3)).toBe('created')
    const readLists = await database.db.selectFrom('readlists').selectAll().execute()
    expect(readLists).toHaveLength(1)
    expect(await readListMembers(database, readLists[0]!.id)).toEqual([{ book_id: 'B1', number: 3 }])
  })

  it('starts a read list with no stated place at the beginning', async () => {
    const database = await setup()
    await addBookToReadList(database.db, 'The Long Way', 'B1', null)

    const readLists = await database.db.selectFrom('readlists').select(['id']).execute()
    expect(await readListMembers(database, readLists[0]!.id)).toEqual([{ book_id: 'B1', number: 0 }])
  })

  it('honours a stated place when it is free, and goes to the end when it is taken', async () => {
    const database = await setup()
    await addBookToReadList(database.db, 'The Long Way', 'B1', 1)

    expect(await addBookToReadList(database.db, 'The Long Way', 'B2', 0)).toBe('added')
    const readLists = await database.db.selectFrom('readlists').select(['id']).execute()
    expect(await readListMembers(database, readLists[0]!.id)).toEqual([
      { book_id: 'B2', number: 0 },
      { book_id: 'B1', number: 1 },
    ])

    expect(await addBookToReadList(database.db, 'The Long Way', 'B1', 7)).toBe('present')
    const other = await setup()
    await addBookToReadList(other.db, 'The Long Way', 'B1', 4)
    expect(await addBookToReadList(other.db, 'The Long Way', 'B2', 4)).toBe('added')
    const otherLists = await other.db.selectFrom('readlists').select(['id']).execute()
    expect(await readListMembers(other, otherLists[0]!.id)).toEqual([
      { book_id: 'B1', number: 4 },
      { book_id: 'B2', number: 5 },
    ])
  })

  it('adds a book with no stated place at the end', async () => {
    const database = await setup()
    await addBookToReadList(database.db, 'The Long Way', 'B1', 2)
    await addBookToReadList(database.db, 'The Long Way', 'B2', null)

    const readLists = await database.db.selectFrom('readlists').select(['id']).execute()
    expect(await readListMembers(database, readLists[0]!.id)).toEqual([
      { book_id: 'B1', number: 2 },
      { book_id: 'B2', number: 3 },
    ])
  })
})
