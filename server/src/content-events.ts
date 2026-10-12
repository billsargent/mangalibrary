/**
 * Telling connected clients that content changed.
 *
 * The browser keeps its own copy of what it is looking at, and the events here are
 * how it learns that something it holds is stale: a series was added, a book's
 * metadata changed, a collection was emptied. The names and shapes are the ones the
 * Komga UI listens for, so they are part of the contract even though they never
 * appear in the OpenAPI document.
 *
 * Every event names what it is about and what it belongs to - a book's event carries
 * its series and library too - because the listener decides what to refresh from
 * that, and a client that has to ask the server what changed in order to know what
 * changed is worse off than one that is told.
 *
 * The events go to every connection. Filtering by what a user may see would mean
 * re-reading each viewer's restrictions for every event, and the reference sends
 * them to everyone as well: a client ignores what it cannot see.
 */

import type { Kysely } from 'kysely'

import type { DB } from './db/schema.js'
import type { EventBus } from './events.js'

/** A library, as an event names it. */
export interface LibraryRef {
  libraryId: string
}

/** A series, with the library it is in. */
export interface SeriesRef {
  seriesId: string
  libraryId: string
}

/** A book, with the series and library it is in. */
export interface BookRef {
  bookId: string
  seriesId: string
  libraryId: string
}

/** A collection, with the series it holds. */
export interface CollectionRef {
  collectionId: string
  seriesIds: string[]
}

/** A read list, with the books it holds. */
export interface ReadListRef {
  readListId: string
  bookIds: string[]
}

/** Where a book sits, or null when there is no such book. */
export async function bookRef(db: Kysely<DB>, bookId: string): Promise<BookRef | null> {
  const row = await db
    .selectFrom('books')
    .select(['id', 'series_id', 'library_id'])
    .where('id', '=', bookId)
    .executeTakeFirst()
  if (!row) return null
  return { bookId: row.id, seriesId: row.series_id, libraryId: row.library_id }
}

/** Where a series sits, or null when there is no such series. */
export async function seriesRef(db: Kysely<DB>, seriesId: string): Promise<SeriesRef | null> {
  const row = await db.selectFrom('series').select(['id', 'library_id']).where('id', '=', seriesId).executeTakeFirst()
  if (!row) return null
  return { seriesId: row.id, libraryId: row.library_id }
}

/** What a collection holds, or null when there is no such collection. */
export async function collectionRef(db: Kysely<DB>, collectionId: string): Promise<CollectionRef | null> {
  const collection = await db.selectFrom('collections').select('id').where('id', '=', collectionId).executeTakeFirst()
  if (!collection) return null

  const members = await db
    .selectFrom('collection_series')
    .select('series_id')
    .where('collection_id', '=', collectionId)
    .orderBy('number')
    .execute()
  return { collectionId, seriesIds: members.map((row) => row.series_id) }
}

/** What a read list holds, or null when there is no such read list. */
export async function readListRef(db: Kysely<DB>, readListId: string): Promise<ReadListRef | null> {
  const readList = await db.selectFrom('readlists').select('id').where('id', '=', readListId).executeTakeFirst()
  if (!readList) return null

  const members = await db
    .selectFrom('readlist_book')
    .select('book_id')
    .where('readlist_id', '=', readListId)
    .orderBy('number')
    .execute()
  return { readListId, bookIds: members.map((row) => row.book_id) }
}

/** A library was added, changed or removed. */
export function announceLibrary(
  events: EventBus,
  name: 'LibraryAdded' | 'LibraryChanged' | 'LibraryDeleted',
  libraryId: string,
): void {
  events.publish({ name, data: { libraryId } satisfies LibraryRef })
}

/** A series was added, changed or removed. */
export function announceSeries(
  events: EventBus,
  name: 'SeriesAdded' | 'SeriesChanged' | 'SeriesDeleted',
  ref: SeriesRef,
): void {
  events.publish({ name, data: ref })
}

/** A book was added, changed or removed. */
export function announceBook(events: EventBus, name: 'BookAdded' | 'BookChanged' | 'BookDeleted', ref: BookRef): void {
  events.publish({ name, data: ref })
}

/** A collection was added, changed or removed. */
export function announceCollection(
  events: EventBus,
  name: 'CollectionAdded' | 'CollectionChanged' | 'CollectionDeleted',
  ref: CollectionRef,
): void {
  events.publish({ name, data: ref })
}

/** A read list was added, changed or removed. */
export function announceReadList(
  events: EventBus,
  name: 'ReadListAdded' | 'ReadListChanged' | 'ReadListDeleted',
  ref: ReadListRef,
): void {
  events.publish({ name, data: ref })
}
