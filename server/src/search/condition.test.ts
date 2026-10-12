import { describe, expect, it } from 'vitest'

import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { bookCondition, seriesCondition, type ConditionResult } from './condition.js'

const USER = 'U1'

/** An instant a few days ago, for the "in the last" operators. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * A library written straight into the tables.
 *
 * The conditions are SQL over the entity tables, so a fixture of rows is all they
 * need - no files, no analysis. What it does need is something of every kind a
 * condition can look at: two series, books that are read and books that are not,
 * tags, genres, labels, authors, a poster, a collection, a read list and a book in
 * the trash.
 */
async function setup(): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db
  const now = new Date().toISOString()

  await db
    .insertInto('libraries')
    .values([
      { id: 'L1', name: 'Main', root: '/main', created_date: now, last_modified_date: now },
      { id: 'L2', name: 'Other', root: '/other', created_date: now, last_modified_date: now },
    ])
    .execute()

  await db
    .insertInto('users')
    .values({
      id: USER,
      email: 'reader@example.com',
      password: 'x',
      roles: JSON.stringify(['ADMIN']),
      shared_all_libraries: 1,
      age_restriction: null,
      age_restriction_allow_only: null,
      created_date: now,
      last_modified_date: now,
    })
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
        book_count: 2,
        oneshot: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'S3',
        library_id: 'L2',
        name: 'Gone',
        url: 'gone',
        file_last_modified: now,
        book_count: 0,
        oneshot: 0,
        deleted_date: now,
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
        title_sort: 'Akira',
        publisher: 'Marvel',
        language: 'en',
        status: 'ONGOING',
        age_rating: 12,
        total_book_count: 2,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S2',
        title: 'Berserk',
        title_sort: 'Berserk',
        publisher: 'DC',
        language: 'fr',
        status: 'ENDED',
        age_rating: null,
        total_book_count: null,
        created_date: now,
        last_modified_date: now,
      },
      {
        series_id: 'S3',
        title: 'Gone',
        title_sort: 'Gone',
        publisher: 'Marvel',
        language: 'en',
        status: 'ENDED',
        age_rating: null,
        total_book_count: null,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('book_metadata_aggregation')
    .values([
      { series_id: 'S1', release_date: '1982-01-01', created_date: now, last_modified_date: now },
      { series_id: 'S2', release_date: null, created_date: now, last_modified_date: now },
    ])
    .execute()

  await db
    .insertInto('series_metadata_tag')
    .values([{ series_id: 'S1', tag: 'Action' }])
    .execute()
  await db
    .insertInto('book_metadata_aggregation_tag')
    .values([{ series_id: 'S1', tag: 'Sci-Fi' }])
    .execute()
  await db
    .insertInto('series_metadata_genre')
    .values([{ series_id: 'S1', genre: 'Drama' }])
    .execute()
  await db
    .insertInto('series_metadata_sharing')
    .values([{ series_id: 'S1', label: 'Family' }])
    .execute()
  await db
    .insertInto('series_metadata_author')
    .values([{ series_id: 'S1', name: 'Otomo', role: 'Writer' }])
    .execute()
  await db
    .insertInto('book_metadata_aggregation_author')
    .values([{ series_id: 'S1', name: 'Miyazaki', role: 'Artist' }])
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
        url: 'v2.pdf',
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
        oneshot: 1,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'B4',
        series_id: 'S2',
        library_id: 'L1',
        name: 'Deleted',
        url: 'gone.cbz',
        file_last_modified: now,
        number: 2,
        oneshot: 0,
        deleted_date: now,
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
        title: 'Astérix le Gaulois',
        number: '1',
        number_sort: 1,
        release_date: daysAgo(3),
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        title: 'Akira Two',
        number: '2',
        number_sort: 2,
        release_date: null,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        title: 'Berserk One',
        number: '1',
        number_sort: 1.5,
        release_date: '1990-05-05',
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B4',
        title: 'Berserk Two',
        number: '2',
        number_sort: 2,
        release_date: '1991-05-05',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('book_metadata_tag')
    .values([{ book_id: 'B1', tag: 'Action' }])
    .execute()
  await db
    .insertInto('book_metadata_author')
    .values([{ book_id: 'B1', name: 'Otomo', role: 'Writer' }])
    .execute()

  await db
    .insertInto('media')
    .values([
      {
        book_id: 'B1',
        media_type: 'application/zip',
        status: 'READY',
        page_count: 10,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B2',
        media_type: 'application/pdf',
        status: 'READY',
        page_count: 5,
        created_date: now,
        last_modified_date: now,
      },
      {
        book_id: 'B3',
        media_type: 'application/epub+zip',
        status: 'ERROR',
        page_count: 0,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('read_progress')
    .values([
      {
        user_id: USER,
        book_id: 'B1',
        page: 3,
        completed: 1,
        read_date: now,
        created_date: now,
        last_modified_date: now,
      },
      {
        user_id: USER,
        book_id: 'B2',
        page: 1,
        completed: 0,
        read_date: null,
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('read_progress_series')
    .values({
      user_id: USER,
      series_id: 'S1',
      read_count: 1,
      in_progress_count: 1,
      created_date: now,
      last_modified_date: now,
    })
    .execute()

  await db
    .insertInto('thumbnails')
    .values([
      {
        id: 'T1',
        owner_type: 'BOOK',
        owner_id: 'B1',
        type: 'GENERATED',
        page: 1,
        selected: 1,
        media_type: 'image/jpeg',
        width: 200,
        height: 300,
        file_size: 10,
        thumbnail: Buffer.from('jpeg'),
        url: null,
        created_date: now,
        last_modified_date: now,
      },
      {
        id: 'T2',
        owner_type: 'BOOK',
        owner_id: 'B2',
        type: 'SIDECAR',
        page: 0,
        selected: 0,
        media_type: 'image/jpeg',
        width: 200,
        height: 300,
        file_size: 10,
        thumbnail: null,
        url: '/covers/v2.jpg',
        created_date: now,
        last_modified_date: now,
      },
    ])
    .execute()

  await db
    .insertInto('collections')
    .values({ id: 'C1', name: 'Favourites', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('collection_series')
    .values([{ collection_id: 'C1', series_id: 'S2' }])
    .execute()
  await db
    .insertInto('readlists')
    .values({ id: 'R1', name: 'To read', created_date: now, last_modified_date: now })
    .execute()
  await db
    .insertInto('readlist_book')
    .values([{ readlist_id: 'R1', book_id: 'B1' }])
    .execute()

  return database
}

/** The books a condition matches, in order. */
async function books(database: Database, condition: unknown): Promise<string[] | ConditionResult> {
  const translated = bookCondition(condition, { userId: USER })
  if ('error' in translated) return translated

  const rows = await database.db
    .selectFrom('books')
    .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
    .leftJoin('media', 'media.book_id', 'books.id')
    .select('books.id')
    .where(translated.filter)
    .orderBy('books.id')
    .execute()
  return rows.map((row) => row.id)
}

/** The series a condition matches, in order. */
async function series(database: Database, condition: unknown): Promise<string[] | ConditionResult> {
  const translated = seriesCondition(condition, { userId: USER })
  if ('error' in translated) return translated

  const rows = await database.db
    .selectFrom('series')
    .innerJoin('series_metadata', 'series_metadata.series_id', 'series.id')
    .leftJoin('book_metadata_aggregation', 'book_metadata_aggregation.series_id', 'series.id')
    .select('series.id')
    .where(translated.filter)
    .orderBy('series.id')
    .execute()
  return rows.map((row) => row.id)
}

describe('a book condition', () => {
  it('filters by library, series, read list and deletion', async () => {
    const database = await setup()

    expect(await books(database, { libraryId: { operator: 'is', value: 'L1' } })).toEqual(['B1', 'B2', 'B3', 'B4'])
    expect(await books(database, { libraryId: { operator: 'isNot', value: 'L1' } })).toEqual([])
    expect(await books(database, { seriesId: { operator: 'is', value: 'S2' } })).toEqual(['B3', 'B4'])
    expect(await books(database, { readListId: { operator: 'is', value: 'R1' } })).toEqual(['B1'])
    expect(await books(database, { readListId: { operator: 'isNot', value: 'R1' } })).toEqual(['B2', 'B3', 'B4'])
    expect(await books(database, { deleted: { operator: 'isTrue' } })).toEqual(['B4'])
    expect(await books(database, { deleted: { operator: 'isFalse' } })).toEqual(['B1', 'B2', 'B3'])
    expect(await books(database, { oneShot: { operator: 'isTrue' } })).toEqual(['B3'])

    await database.close()
  })

  it('compares a title ignoring case and accents, and looks inside words', async () => {
    const database = await setup()

    // The stored title is "Astérix le Gaulois": nobody types the accent, and the
    // compare is case-insensitive.
    expect(await books(database, { title: { operator: 'contains', value: 'asterix' } })).toEqual(['B1'])
    expect(await books(database, { title: { operator: 'contains', value: 'ASTÉRIX' } })).toEqual(['B1'])
    expect(await books(database, { title: { operator: 'beginsWith', value: 'akira' } })).toEqual(['B2'])
    expect(await books(database, { title: { operator: 'endsWith', value: 'two' } })).toEqual(['B2', 'B4'])
    expect(await books(database, { title: { operator: 'doesNotContain', value: 'a' } })).toEqual(['B3', 'B4'])
    expect(await books(database, { title: { operator: 'doesNotBeginWith', value: 'A' } })).toEqual(['B3', 'B4'])
    expect(await books(database, { title: { operator: 'doesNotEndWith', value: 'o' } })).toEqual(['B1', 'B3'])
    expect(await books(database, { title: { operator: 'is', value: 'AKIRA TWO' } })).toEqual(['B2'])
    expect(await books(database, { title: { operator: 'isNot', value: 'Akira Two' } })).toEqual(['B1', 'B3', 'B4'])

    await database.close()
  })

  it('filters by release date, in the last days, and by number', async () => {
    const database = await setup()

    expect(await books(database, { releaseDate: { operator: 'after', dateTime: '1990-01-01T00:00:00Z' } })).toEqual([
      'B1',
      'B3',
      'B4',
    ])
    expect(await books(database, { releaseDate: { operator: 'before', dateTime: '1990-06-01T00:00:00Z' } })).toEqual([
      'B3',
    ])
    expect(await books(database, { releaseDate: { operator: 'isInTheLast', duration: 'P7D' } })).toEqual(['B1'])
    expect(await books(database, { releaseDate: { operator: 'isNotInTheLast', duration: 'P7D' } })).toEqual([
      'B3',
      'B4',
    ])
    expect(await books(database, { releaseDate: { operator: 'isNull' } })).toEqual(['B2'])
    expect(await books(database, { releaseDate: { operator: 'isNotNull' } })).toEqual(['B1', 'B3', 'B4'])

    // The range operators are inclusive, as the reference's are.
    expect(await books(database, { numberSort: { operator: 'is', value: 1.5 } })).toEqual(['B3'])
    expect(await books(database, { numberSort: { operator: 'greaterThan', value: 1.5 } })).toEqual(['B2', 'B3', 'B4'])
    expect(await books(database, { numberSort: { operator: 'lessThan', value: 1.5 } })).toEqual(['B1', 'B3'])
    expect(await books(database, { numberSort: { operator: 'isNot', value: 1.5 } })).toEqual(['B1', 'B2', 'B4'])

    await database.close()
  })

  it('filters by tag, author and poster', async () => {
    const database = await setup()

    expect(await books(database, { tag: { operator: 'is', value: 'action' } })).toEqual(['B1'])
    expect(await books(database, { tag: { operator: 'isNot', value: 'Action' } })).toEqual(['B2', 'B3', 'B4'])
    expect(await books(database, { tag: { operator: 'isNull' } })).toEqual(['B2', 'B3', 'B4'])
    expect(await books(database, { tag: { operator: 'isNotNull' } })).toEqual(['B1'])

    expect(await books(database, { author: { operator: 'is', value: { name: 'otomo' } } })).toEqual(['B1'])
    expect(await books(database, { author: { operator: 'is', value: { role: 'writer' } } })).toEqual(['B1'])
    expect(await books(database, { author: { operator: 'is', value: { name: 'Otomo', role: 'Artist' } } })).toEqual([])
    expect(await books(database, { author: { operator: 'isNot', value: { name: 'Otomo' } } })).toEqual([
      'B2',
      'B3',
      'B4',
    ])

    expect(await books(database, { poster: { operator: 'is', value: { type: 'GENERATED' } } })).toEqual(['B1'])
    expect(await books(database, { poster: { operator: 'is', value: { selected: true } } })).toEqual(['B1'])
    expect(await books(database, { poster: { operator: 'isNot', value: { type: 'GENERATED' } } })).toEqual([
      'B2',
      'B3',
      'B4',
    ])

    await database.close()
  })

  it('filters by read status of the caller', async () => {
    const database = await setup()

    expect(await books(database, { readStatus: { operator: 'is', value: 'READ' } })).toEqual(['B1'])
    expect(await books(database, { readStatus: { operator: 'is', value: 'IN_PROGRESS' } })).toEqual(['B2'])
    expect(await books(database, { readStatus: { operator: 'is', value: 'UNREAD' } })).toEqual(['B3', 'B4'])
    expect(await books(database, { readStatus: { operator: 'isNot', value: 'UNREAD' } })).toEqual(['B1', 'B2'])
    expect(await books(database, { readStatus: { operator: 'isNot', value: 'READ' } })).toEqual(['B2', 'B3', 'B4'])
    expect(await books(database, { readStatus: { operator: 'isNot', value: 'IN_PROGRESS' } })).toEqual([
      'B1',
      'B3',
      'B4',
    ])

    // Without a caller there is no read progress, and nothing matches - which is
    // what the reference answers too.
    const anonymous = bookCondition({ readStatus: { operator: 'is', value: 'UNREAD' } }, { userId: null })
    expect('filter' in anonymous).toBe(true)

    await database.close()
  })

  it('filters by media status and profile', async () => {
    const database = await setup()

    // A book with no media row at all is neither READY nor any other status: the
    // reference compares a joined column, and a missing row is not a value.
    expect(await books(database, { mediaStatus: { operator: 'is', value: 'READY' } })).toEqual(['B1', 'B2'])
    expect(await books(database, { mediaStatus: { operator: 'isNot', value: 'READY' } })).toEqual(['B3'])
    expect(await books(database, { mediaProfile: { operator: 'is', value: 'DIVINA' } })).toEqual(['B1'])
    expect(await books(database, { mediaProfile: { operator: 'is', value: 'PDF' } })).toEqual(['B2'])
    expect(await books(database, { mediaProfile: { operator: 'isNot', value: 'PDF' } })).toEqual(['B1', 'B3'])

    await database.close()
  })

  it('groups conditions with allOf and anyOf', async () => {
    const database = await setup()

    expect(
      await books(database, {
        allOf: [{ libraryId: { operator: 'is', value: 'L1' } }, { title: { operator: 'contains', value: 'Berserk' } }],
      }),
    ).toEqual(['B3', 'B4'])

    expect(
      await books(database, {
        anyOf: [{ title: { operator: 'is', value: 'Akira Two' } }, { mediaProfile: { operator: 'is', value: 'PDF' } }],
      }),
    ).toEqual(['B2'])

    // Nesting, and an `anyOf` inside an `allOf`.
    expect(
      await books(database, {
        allOf: [
          { libraryId: { operator: 'is', value: 'L1' } },
          {
            anyOf: [{ oneShot: { operator: 'isTrue' } }, { tag: { operator: 'is', value: 'Action' } }],
          },
        ],
      }),
    ).toEqual(['B1', 'B3'])

    expect(await books(database, { allOf: [] })).toEqual({ error: 'allOf must hold at least one condition' })

    await database.close()
  })

  it('refuses a field or operator it does not know', async () => {
    const database = await setup()

    expect(await books(database, { nonsense: { operator: 'is', value: 'x' } })).toEqual({
      error: 'nonsense is not a field a book search knows',
    })
    expect(await books(database, { title: { operator: 'greaterThan', value: 3 } })).toEqual({
      error:
        'title does not take the operator greaterThan; it takes is, isNot, contains, doesNotContain, beginsWith, doesNotBeginWith, endsWith, doesNotEndWith',
    })
    expect(await books(database, { title: { operator: 'contains' } })).toEqual({
      error: 'title contains needs a value that is a string',
    })
    expect(await books(database, { title: { operator: 'contains', value: 'a' }, tag: { operator: 'isNull' } })).toEqual(
      {
        error: 'a book condition names one field, not title, tag',
      },
    )
    expect(await books(database, {})).toEqual({ error: 'a book condition must name a field' })
    expect(await books(database, 'Akira')).toEqual({ error: 'a book condition must be an object' })
    expect(await books(database, { releaseDate: { operator: 'isInTheLast', duration: 'P1M' } })).toEqual({
      error: 'releaseDate isInTheLast needs a duration such as P7D, not P1M',
    })
    expect(await books(database, { numberSort: { operator: 'is', value: 'one' } })).toEqual({
      error: 'numberSort is needs a value that is a number',
    })

    await database.close()
  })
})

describe('a series condition', () => {
  it('filters by library, collection, deletion, completeness and oneShot', async () => {
    const database = await setup()

    expect(await series(database, { libraryId: { operator: 'is', value: 'L1' } })).toEqual(['S1', 'S2'])
    expect(await series(database, { libraryId: { operator: 'is', value: 'L2' } })).toEqual(['S3'])
    expect(await series(database, { collectionId: { operator: 'is', value: 'C1' } })).toEqual(['S2'])
    expect(await series(database, { collectionId: { operator: 'isNot', value: 'C1' } })).toEqual(['S1', 'S3'])
    expect(await series(database, { deleted: { operator: 'isTrue' } })).toEqual(['S3'])
    expect(await series(database, { oneShot: { operator: 'isTrue' } })).toEqual(['S2'])

    // S1 declares two books and has two; S2 declares nothing.
    expect(await series(database, { complete: { operator: 'isTrue' } })).toEqual(['S1'])
    expect(await series(database, { complete: { operator: 'isFalse' } })).toEqual(['S2', 'S3'])

    await database.close()
  })

  it('filters by title, title sort, publisher, language, status and age rating', async () => {
    const database = await setup()

    expect(await series(database, { title: { operator: 'contains', value: 'kir' } })).toEqual(['S1'])
    expect(await series(database, { titleSort: { operator: 'beginsWith', value: 'ber' } })).toEqual(['S2'])
    expect(await series(database, { publisher: { operator: 'is', value: 'marvel' } })).toEqual(['S1', 'S3'])
    expect(await series(database, { publisher: { operator: 'isNot', value: 'Marvel' } })).toEqual(['S2'])
    expect(await series(database, { language: { operator: 'is', value: 'EN' } })).toEqual(['S1', 'S3'])
    expect(await series(database, { seriesStatus: { operator: 'is', value: 'ONGOING' } })).toEqual(['S1'])
    expect(await series(database, { seriesStatus: { operator: 'isNot', value: 'ONGOING' } })).toEqual(['S2', 'S3'])

    expect(await series(database, { ageRating: { operator: 'is', value: 12 } })).toEqual(['S1'])
    expect(await series(database, { ageRating: { operator: 'isNull' } })).toEqual(['S2', 'S3'])
    expect(await series(database, { ageRating: { operator: 'isNot', value: 12 } })).toEqual(['S2', 'S3'])
    expect(await series(database, { ageRating: { operator: 'greaterThan', value: 12 } })).toEqual(['S1'])

    await database.close()
  })

  it('filters by tag, including the tags its books carry, and by genre, label and author', async () => {
    const database = await setup()

    expect(await series(database, { tag: { operator: 'is', value: 'action' } })).toEqual(['S1'])
    expect(await series(database, { tag: { operator: 'is', value: 'sci-fi' } })).toEqual(['S1'])
    expect(await series(database, { tag: { operator: 'isNull' } })).toEqual(['S2', 'S3'])
    expect(await series(database, { tag: { operator: 'isNotNull' } })).toEqual(['S1'])

    expect(await series(database, { genre: { operator: 'is', value: 'drama' } })).toEqual(['S1'])
    expect(await series(database, { genre: { operator: 'isNull' } })).toEqual(['S2', 'S3'])
    expect(await series(database, { sharingLabel: { operator: 'is', value: 'family' } })).toEqual(['S1'])
    expect(await series(database, { sharingLabel: { operator: 'isNotNull' } })).toEqual(['S1'])
    expect(await series(database, { author: { operator: 'is', value: { name: 'miyazaki' } } })).toEqual(['S1'])
    expect(await series(database, { author: { operator: 'is', value: { role: 'artist' } } })).toEqual(['S1'])
    expect(await series(database, { author: { operator: 'isNot', value: { name: 'Miyazaki' } } })).toEqual(['S2', 'S3'])

    // The author row a series carries itself is not one its books carry, so it is
    // not what a series search looks at - the reference aggregates the books' authors.
    expect(await series(database, { author: { operator: 'is', value: { name: 'otomo' } } })).toEqual([])

    await database.close()
  })

  it('filters by read status, and by release date of the books it holds', async () => {
    const database = await setup()

    // S1 has one of its two books read, so it is in progress and nothing is
    // finished; S2 and S3 have no read progress row at all, which is what unread
    // means for a series - even though S3 holds no books to read.
    expect(await series(database, { readStatus: { operator: 'is', value: 'READ' } })).toEqual([])
    expect(await series(database, { readStatus: { operator: 'is', value: 'IN_PROGRESS' } })).toEqual(['S1'])
    expect(await series(database, { readStatus: { operator: 'is', value: 'UNREAD' } })).toEqual(['S2', 'S3'])
    expect(await series(database, { readStatus: { operator: 'isNot', value: 'UNREAD' } })).toEqual(['S1'])
    expect(await series(database, { readStatus: { operator: 'isNot', value: 'READ' } })).toEqual(['S1', 'S2', 'S3'])
    expect(await series(database, { readStatus: { operator: 'isNot', value: 'IN_PROGRESS' } })).toEqual(['S2', 'S3'])

    expect(await series(database, { releaseDate: { operator: 'after', dateTime: '1980-01-01T00:00:00Z' } })).toEqual([
      'S1',
    ])
    expect(await series(database, { releaseDate: { operator: 'isNull' } })).toEqual(['S2', 'S3'])

    await database.close()
  })

  it('refuses a field that belongs to a book', async () => {
    const database = await setup()

    expect(await series(database, { numberSort: { operator: 'is', value: 1 } })).toEqual({
      error: 'numberSort is not a field a series search knows',
    })

    await database.close()
  })
})
