/**
 * Putting a series in a collection, and a book in a read list.
 *
 * A library that keeps its organisation in its metadata documents says so with a
 * name - a `SeriesGroup`, a story arc - rather than with an id, so both of these
 * work by name: the collection or the read list is created when it does not exist
 * yet, and a member that is already there is left where it is. Nothing is ever
 * removed by these: a read list a user has curated is theirs, and a document that
 * stopped mentioning it does not take the book out of it.
 *
 * The reference does the same, and takes the same care over where a book lands: a
 * number a document states is honoured when it is free, and a book whose stated
 * place is taken goes to the end rather than displacing what is there.
 */

import { sql, type Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import { nextTsid } from '../tsid.js'

/**
 * The collection or read list that has a name, whatever its capitals - which is how
 * the reference looks one up, and what makes "Batman" and "batman" one list - or
 * undefined. `exceptId` leaves one out, for asking whether a rename would collide.
 */
export async function setNamed(
  db: Kysely<DB>,
  table: 'collections' | 'readlists',
  name: string,
  exceptId?: string,
): Promise<{ id: string } | undefined> {
  let query = db
    .selectFrom(table)
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${name})`)
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId)
  return query.orderBy('id').executeTakeFirst()
}

/** What putting something in the organisation did. */
export type MembershipOutcome = 'created' | 'added' | 'present'

/** The next free place in a list, which is one past its last. */
async function nextNumber(
  db: Kysely<DB>,
  table: 'collection_series' | 'readlist_book',
  column: 'collection_id' | 'readlist_id',
  id: string,
): Promise<number> {
  const rows = await db.selectFrom(table).select('number').where(column, '=', id).execute()
  return rows.reduce((highest, row) => (row.number > highest ? row.number : highest), -1) + 1
}

/**
 * Add a series to the collection with a name, creating the collection when it does
 * not exist.
 */
export async function addSeriesToCollection(
  db: Kysely<DB>,
  name: string,
  seriesId: string,
): Promise<MembershipOutcome> {
  const collection = await setNamed(db, 'collections', name)
  const now = new Date().toISOString()

  if (collection === undefined) {
    const id = nextTsid()
    await db
      .insertInto('collections')
      // Not ordered by hand: nobody arranged it, so it lists by title, as the
      // reference's does.
      .values({ id, name, ordered: 0, created_date: now, last_modified_date: now })
      .execute()
    await db.insertInto('collection_series').values({ collection_id: id, series_id: seriesId, number: 0 }).execute()
    return 'created'
  }

  const member = await db
    .selectFrom('collection_series')
    .select('series_id')
    .where('collection_id', '=', collection.id)
    .where('series_id', '=', seriesId)
    .executeTakeFirst()
  if (member !== undefined) return 'present'

  await db
    .insertInto('collection_series')
    .values({
      collection_id: collection.id,
      series_id: seriesId,
      number: await nextNumber(db, 'collection_series', 'collection_id', collection.id),
    })
    .execute()
  await db.updateTable('collections').set({ last_modified_date: now }).where('id', '=', collection.id).execute()
  return 'added'
}

/**
 * Add a book to the read list with a name, creating the read list when it does not
 * exist.
 *
 * A number the document states is where the book goes, unless that place is taken;
 * a document that states no number adds the book at the end, and a read list that
 * is created holds the book wherever the document put it.
 */
export async function addBookToReadList(
  db: Kysely<DB>,
  name: string,
  bookId: string,
  number: number | null,
): Promise<MembershipOutcome> {
  const readList = await setNamed(db, 'readlists', name)
  const now = new Date().toISOString()

  if (readList === undefined) {
    const id = nextTsid()
    await db
      .insertInto('readlists')
      .values({ id, name, ordered: 1, created_date: now, last_modified_date: now })
      .execute()
    await db
      .insertInto('readlist_book')
      .values({ readlist_id: id, book_id: bookId, number: number ?? 0 })
      .execute()
    return 'created'
  }

  const member = await db
    .selectFrom('readlist_book')
    .select('book_id')
    .where('readlist_id', '=', readList.id)
    .where('book_id', '=', bookId)
    .executeTakeFirst()
  if (member !== undefined) return 'present'

  const taken =
    number === null
      ? false
      : (await db
          .selectFrom('readlist_book')
          .select('book_id')
          .where('readlist_id', '=', readList.id)
          .where('number', '=', number)
          .executeTakeFirst()) !== undefined

  const place = number !== null && !taken ? number : await nextNumber(db, 'readlist_book', 'readlist_id', readList.id)
  await db.insertInto('readlist_book').values({ readlist_id: readList.id, book_id: bookId, number: place }).execute()
  await db.updateTable('readlists').set({ last_modified_date: now }).where('id', '=', readList.id).execute()
  return 'added'
}
