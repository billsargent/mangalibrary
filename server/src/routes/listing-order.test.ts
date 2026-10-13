import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { AuthUser } from '../auth/types.js'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { scanLibrary } from '../scan/reconcile.js'
import { bookCondition } from '../search/condition.js'
import { bookSorts, findBooks, type BookQueryFilters } from './books.js'
import type { ContentContext } from './context.js'
import { parseSort } from './query.js'

/**
 * A listing is found in more than one way - straight off an index when nothing
 * narrows it, through whatever narrows it otherwise - and the ways must agree.
 * Each order here is worked out a second time, in plain code, from the rows
 * themselves, and the listing has to match it page by page.
 */

interface Row {
  id: string
  seriesId: string
  title: string
  number: number
  released: string | null
  created: string
}

async function setup(): Promise<{ database: Database; rows: Row[]; context: ContentContext }> {
  const root = mkdtempSync(join(tmpdir(), 'ml-listing-'))
  for (const series of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    mkdirSync(join(root, series))
    for (let book = 1; book <= 5; book += 1) writeFileSync(join(root, series, `book ${book}.cbz`), `${series} ${book}`)
  }
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const db = database.db
  await db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root, created_date: 'now', last_modified_date: 'now' } as never)
    .execute()
  await scanLibrary(db, 'L1')

  // Values with plenty of ties, because ties are where two ways of ordering differ:
  // two series sorted under one title, five numbers shared by twenty books, two
  // dates of arrival, and release dates that are missing as often as not.
  const titles: Record<string, string> = { Alpha: 'same', Beta: 'same', Gamma: 'apart', Delta: 'zed' }
  for (const series of await db.selectFrom('series').select(['id', 'name']).execute()) {
    await db
      .updateTable('series_metadata')
      .set({ title_sort: titles[series.name]! })
      .where('series_id', '=', series.id)
      .execute()
  }
  const books = await db.selectFrom('books').select(['id', 'name']).orderBy('id').execute()
  for (const [index, book] of books.entries()) {
    const number = Number(book.name.split(' ')[1])
    await db
      .updateTable('books')
      .set({ created_date: index % 3 === 0 ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z' })
      .where('id', '=', book.id)
      .execute()
    await db
      .updateTable('book_metadata')
      .set({
        number_sort: Math.ceil(number / 2),
        release_date: index % 2 === 0 ? null : index % 4 === 1 ? '2020-05-05' : '2021-06-06',
      })
      .where('book_id', '=', book.id)
      .execute()
  }

  const user = { id: 'U1', email: 'reader@example.com', roles: ['ADMIN'] } as unknown as AuthUser
  await db
    .insertInto('users')
    .values({
      id: 'U1',
      email: user.email,
      password: 'x',
      created_date: 'now',
      last_modified_date: 'now',
    } as never)
    .execute()

  const rows = (
    await db
      .selectFrom('books')
      .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
      .innerJoin('series_metadata', 'series_metadata.series_id', 'books.series_id')
      .select([
        'books.id',
        'books.series_id',
        'series_metadata.title_sort',
        'book_metadata.number_sort',
        'book_metadata.release_date',
        'books.created_date',
      ])
      .execute()
  ).map((row) => ({
    id: row.id,
    seriesId: row.series_id,
    title: row.title_sort,
    number: row.number_sort,
    released: row.release_date,
    created: row.created_date,
  }))
  return { database, rows, context: { user, libraryIds: ['L1'], restrictedSeriesIds: null } }
}

type Key = (row: Row) => string | number | null
const KEYS: Record<string, Key> = {
  series: (row) => row.title,
  'metadata.numberSort': (row) => row.number,
  'metadata.releaseDate': (row) => row.released,
  createdDate: (row) => row.created,
}

/** As SQLite compares: nothing sorts before anything. */
function compare(left: string | number | null, right: string | number | null): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  return left < right ? -1 : 1
}

/** The order a sort means, worked out from the rows: each term, then the id. */
function expected(rows: readonly Row[], sort: readonly string[], tiebreak: 'asc' | 'desc'): string[] {
  const terms = sort.map((entry) => {
    const [name, direction = 'asc'] = entry.split(',')
    return { key: KEYS[name!]!, sign: direction === 'desc' ? -1 : 1 }
  })
  return [...rows]
    .sort((left, right) => {
      for (const term of terms) {
        const order = compare(term.key(left), term.key(right)) * term.sign
        if (order !== 0) return order
      }
      return compare(left.id, right.id) * (tiebreak === 'desc' ? -1 : 1)
    })
    .map((row) => row.id)
}

/** Every page of a listing, one after another, and the total it reported. */
async function listed(
  database: Database,
  context: ContentContext,
  filters: Partial<BookQueryFilters>,
  sort: readonly string[],
  size = 7,
): Promise<{ ids: string[]; total: number }> {
  const sorts = parseSort(sort, bookSorts(context.user.id), [])
  const ids: string[] = []
  let total = 0
  for (let page = 0; page < 10; page += 1) {
    const found = await findBooks(database.db, context, { libraryIds: ['L1'], ...filters }, sorts, page, size, false)
    total = found.total
    if (found.rows.length === 0) break
    ids.push(...found.rows.map((row) => row.id))
  }
  return { ids, total }
}

describe('a library listed in the orders it is browsed in', () => {
  // The first term's direction is the direction ties are broken in, when the
  // listing is read off the index of that term.
  const orders: [string[], 'asc' | 'desc'][] = [
    [['metadata.numberSort,asc'], 'asc'],
    [['metadata.numberSort,desc'], 'desc'],
    [['series,asc', 'metadata.numberSort,asc'], 'asc'],
    [['series,desc', 'metadata.numberSort,asc'], 'desc'],
    [['series,asc', 'metadata.numberSort,desc'], 'asc'],
    [['createdDate,desc'], 'desc'],
    [['createdDate,asc'], 'asc'],
    [['metadata.releaseDate,desc'], 'desc'],
    [['metadata.releaseDate,asc', 'metadata.numberSort,asc'], 'asc'],
  ]

  it.each(orders)('by %j', async (sort, tiebreak) => {
    const { database, rows, context } = await setup()
    const { ids, total } = await listed(database, context, {}, sort)
    expect(total).toBe(20)
    expect(ids).toEqual(expected(rows, sort, tiebreak))
  })

  it('is the same listing when a condition says which library, as the web UI always does', async () => {
    const { database, rows, context } = await setup()
    const condition = bookCondition({ libraryId: { operator: 'is', value: 'L1' } }, { userId: 'U1' })
    if ('error' in condition) throw new Error(condition.error)

    const sort = ['series,asc', 'metadata.numberSort,asc']
    const { ids, total } = await listed(database, context, { condition: condition.filter }, sort)
    expect(total).toBe(20)
    expect(ids).toEqual(expected(rows, sort, 'asc'))
  })
})

describe('a listing that something narrows', () => {
  it('of one series: its books, in order, with ties by id', async () => {
    const { database, rows, context } = await setup()
    const seriesId = rows[0]!.seriesId
    const sort = ['metadata.numberSort,desc']

    const { ids, total } = await listed(database, context, { seriesId }, sort, 2)
    const own = rows.filter((row) => row.seriesId === seriesId)
    expect(total).toBe(5)
    expect(ids).toEqual(expected(own, sort, 'asc'))
  })

  it('by what a reader has read, is reading and has not opened', async () => {
    const { database, rows, context } = await setup()
    const byId = [...rows].sort((left, right) => compare(left.id, right.id))
    const [finished, started, alsoStarted] = byId
    await database.db
      .insertInto('read_progress')
      .values(
        [
          [finished!, 1],
          [started!, 0],
          [alsoStarted!, 0],
        ].map(([row, completed]) => ({
          book_id: (row as Row).id,
          user_id: 'U1',
          page: 1,
          completed: completed as number,
          created_date: 'now',
          last_modified_date: 'now',
        })) as never,
      )
      .execute()
    const sort = ['metadata.numberSort,asc']
    const of = (wanted: readonly Row[]) => expected(wanted, sort, 'asc')

    // Asked the old way, by a query parameter, one book to a page.
    expect(await listed(database, context, { readStatuses: ['IN_PROGRESS'] }, sort, 1)).toEqual({
      ids: of([started!, alsoStarted!]),
      total: 2,
    })
    expect(await listed(database, context, { readStatuses: ['READ', 'IN_PROGRESS'] }, sort)).toEqual({
      ids: of([finished!, started!, alsoStarted!]),
      total: 3,
    })
    const unread = await listed(database, context, { readStatuses: ['UNREAD'] }, sort)
    expect(unread).toEqual({ ids: of(byId.slice(3)), total: 17 })

    // And the new way, by a condition, which is what the home page sends.
    for (const [value, operator, wanted] of [
      ['IN_PROGRESS', 'is', [started!, alsoStarted!]],
      ['READ', 'is', [finished!]],
      ['UNREAD', 'is', byId.slice(3)],
      ['UNREAD', 'isNot', byId.slice(0, 3)],
      ['READ', 'isNot', byId.slice(1)],
    ] as const) {
      const condition = bookCondition({ readStatus: { operator, value } }, { userId: 'U1' })
      if ('error' in condition) throw new Error(condition.error)
      const found = await listed(database, context, { condition: condition.filter }, sort, 3)
      expect([value, operator, found]).toEqual([value, operator, { ids: of(wanted), total: wanted.length }])
    }
  })

  it('to the series a reader may see', async () => {
    const { database, rows, context } = await setup()
    const allowed = [...new Set(rows.map((row) => row.seriesId))].slice(0, 2)
    const sort = ['series,asc', 'metadata.numberSort,asc']

    const found = await listed(database, { ...context, restrictedSeriesIds: allowed }, {}, sort)
    const visible = rows.filter((row) => allowed.includes(row.seriesId))
    expect(found).toEqual({ ids: expected(visible, sort, 'asc'), total: 10 })
  })
})
