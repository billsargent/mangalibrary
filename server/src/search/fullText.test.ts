import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { INDEXES, matchExpression, matchingIds } from './fullText.js'

/**
 * A library of rows, with nothing on disk.
 *
 * The indexes are FTS5 tables kept in step by triggers, so writing the rows is what
 * writes the index - which is also what some of these tests are about.
 */
async function setup(): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db
  const now = new Date().toISOString()

  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/main', created_date: now, last_modified_date: now })
    .execute()

  await db
    .insertInto('series')
    .values([
      {
        id: 'S1',
        library_id: 'L1',
        name: 'Akira',
        url: 'akira',
        file_last_modified: now,
        book_count: 2,
        oneshot: 0,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S2',
        library_id: 'L1',
        name: 'Berserk',
        url: 'berserk',
        file_last_modified: now,
        book_count: 1,
        oneshot: 0,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('series_metadata')
    .values([
      {
        series_id: 'S1',
        title: 'Akira',
        title_sort: 'Akira Original',
        publisher: 'Kodansha',
        language: 'en',
        status: 'ONGOING',
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        title: 'Berserk',
        title_sort: 'Berserk',
        publisher: 'Hakusensha',
        language: 'en',
        status: 'ONGOING',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('books')
    .values([
      {
        id: 'B1',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'v1.cbz',
        file_last_modified: now,
        number: 1,
        oneshot: 0,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B2',
        series_id: 'S1',
        library_id: 'L1',
        name: 'Volume 2',
        url: 'v2.cbz',
        file_last_modified: now,
        number: 2,
        oneshot: 0,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B3',
        series_id: 'S2',
        library_id: 'L1',
        name: 'Volume 1',
        url: 'b1.cbz',
        file_last_modified: now,
        number: 1,
        oneshot: 0,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('book_metadata')
    .values([
      {
        book_id: 'B1',
        title: 'Akira',
        isbn: '9784063196899',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        title: 'Akira Companion Extra Volume',
        isbn: '',
        number: '2',
        number_sort: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        title: 'Animations of Berserk',
        isbn: '',
        number: '1',
        number_sort: 1,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Akira Collection', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('readlists')
    .values({ id: 'R1', name: 'Winter reading', created_date: now, last_modified_date: now })
    .execute()

  return database
}

describe('a search term as an FTS5 expression', () => {
  it('quotes the words, so the query language cannot be reached', () => {
    expect(matchExpression('fts_books', 'akira')).toBe('{title isbn} : ("akira")')
    expect(matchExpression('fts_books', 'akira two')).toBe('{title isbn} : ("akira" AND "two")')
    expect(matchExpression('fts_series', 'akira')).toBe('{title title_sort} : ("akira")')

    // A trailing star is the one piece of the search language a client may use: it
    // makes the word a prefix, which is what a search box wants while typing.
    expect(matchExpression('fts_books', 'akir*')).toBe('{title isbn} : ("akir"*)')

    // What would be syntax in an FTS5 query - or in Lucene's - is punctuation in a
    // search box, apart from that one star.
    expect(matchExpression('fts_books', '-akira')).toBe('{title isbn} : ("akira")')
    expect(matchExpression('fts_books', 'akira?')).toBe('{title isbn} : ("akira")')
    expect(matchExpression('fts_books', 'ak*ra')).toBe('{title isbn} : ("akra")')
    expect(matchExpression('fts_books', 'NEAR(akira')).toBe('{title isbn} : ("NEAR" AND "akira")')
    expect(matchExpression('fts_books', '"')).toBeNull()
    expect(matchExpression('fts_books', '*')).toBeNull()
    expect(matchExpression('fts_books', '!!!')).toBeNull()
    expect(matchExpression('fts_books', '   ')).toBeNull()
  })

  it('refuses an index it does not know', () => {
    expect(() => matchExpression('fts_nonsense', 'akira')).toThrow('not a full-text index')
  })
})

describe('what a search finds', () => {
  it('finds a book by its title or its ISBN, and a series by either of its titles', async () => {
    const database = await setup()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akira')).toEqual(['B1', 'B2'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, '9784063196899')).toEqual(['B1'])
    expect(await matchingIds(database.db, INDEXES.SERIES, 'akira')).toEqual(['S1'])
    // The title sort is what a list shows, so searching for it finds the series.
    expect(await matchingIds(database.db, INDEXES.SERIES, 'original')).toEqual(['S1'])
    expect(await matchingIds(database.db, INDEXES.COLLECTIONS, 'akira')).toEqual(['C1'])
    expect(await matchingIds(database.db, INDEXES.READ_LISTS, 'winter')).toEqual(['R1'])

    await database.close()
  })

  it('stems, so a word finds its other forms', async () => {
    const database = await setup()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'animation')).toEqual(['B3'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'animations')).toEqual(['B3'])

    await database.close()
  })

  it('asks for every word, not any of them', async () => {
    const database = await setup()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akira companion')).toEqual(['B2'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akira berserk')).toEqual([])

    await database.close()
  })

  it('puts the best match first', async () => {
    const database = await setup()

    // The book titled exactly "Akira" is a better match than the longer one.
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akira')).toEqual(['B1', 'B2'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'companion')).toEqual(['B2'])

    await database.close()
  })

  it('takes a trailing star as a prefix', async () => {
    const database = await setup()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akir*')).toEqual(['B1', 'B2'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'comp*')).toEqual(['B2'])
    // Without the star the whole word has to be there.
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'akir')).toEqual([])

    await database.close()
  })

  it('matches nothing rather than everything for a term it cannot use', async () => {
    const database = await setup()

    expect(await matchingIds(database.db, INDEXES.BOOKS, '!!!')).toEqual([])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'nothing here')).toEqual([])

    await database.close()
  })
})

describe('keeping the index in step', () => {
  it('indexes a book when it is written, follows a changed title, and forgets a deleted one', async () => {
    const database = await setup()
    const now = new Date().toISOString()

    await database.db
      .insertInto('book_metadata')
      .values({
        book_id: 'B3',
        title: 'Blame!',
        isbn: '',
        number: '2',
        number_sort: 2,
        created_date: now,
        last_modified_date: now,
      })
      .onConflict((oc) => oc.column('book_id').doUpdateSet({ title: 'Blame!', last_modified_date: now }))
      .execute()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'blame')).toEqual(['B3'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'berserk')).toEqual([])

    await database.db
      .updateTable('book_metadata')
      .set({ title: 'Blame! Master Edition', last_modified_date: now })
      .where('book_id', '=', 'B3')
      .execute()

    expect(await matchingIds(database.db, INDEXES.BOOKS, 'master')).toEqual(['B3'])
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'blame')).toEqual(['B3'])

    await database.db.deleteFrom('book_metadata').where('book_id', '=', 'B3').execute()
    expect(await matchingIds(database.db, INDEXES.BOOKS, 'blame')).toEqual([])

    await database.close()
  })
})
