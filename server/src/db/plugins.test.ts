import { describe, expect, it } from 'vitest'

import { enqueueJobs } from '../jobs.js'
import { createDatabase } from './index.js'
import { migrate } from './migrate.js'
import { migrations } from './migrations/index.js'
import { LONG_LIST } from './plugins.js'

async function withBooks(count: number) {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = '2026-01-01T00:00:00.000Z'
  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Main', root: '/books', created_date: now, last_modified_date: now } as never)
    .execute()
  await database.db
    .insertInto('series')
    .values({
      id: 'S1',
      library_id: 'L1',
      name: 'S1',
      url: 'file:///S1',
      file_last_modified: now,
      created_date: now,
      last_modified_date: now,
    } as never)
    .execute()

  const ids = Array.from({ length: count }, (_, index) => `B${String(index).padStart(6, '0')}`)
  for (let start = 0; start < ids.length; start += 500) {
    await database.db
      .insertInto('books')
      .values(
        ids.slice(start, start + 500).map((id) => ({
          id,
          series_id: 'S1',
          library_id: 'L1',
          name: id,
          url: `file:///${id}`,
          file_last_modified: now,
          file_size: 1,
          created_date: now,
          last_modified_date: now,
        })) as never,
      )
      .execute()
  }
  return { database, ids }
}

describe('a long list of ids', () => {
  it('is passed as one value, so a list past the database’s limit still works', async () => {
    // More than SQLite will bind in one statement.
    const { database, ids } = await withBooks(40_000)
    const asked = ids.filter((_, index) => index % 2 === 0)

    const found = await database.db.selectFrom('books').select('id').where('id', 'in', asked).execute()
    expect(found).toHaveLength(20_000)

    const compiled = database.db.selectFrom('books').select('id').where('id', 'in', asked).compile()
    expect(compiled.sql).toContain('json_each')
    expect(compiled.parameters).toHaveLength(1)

    const others = await database.db.selectFrom('books').select('id').where('id', 'not in', asked).execute()
    expect(others).toHaveLength(20_000)

    const result = await database.db.updateTable('books').set({ number: 7 }).where('id', 'in', asked).executeTakeFirst()
    expect(Number(result.numUpdatedRows)).toBe(20_000)
  })

  it('leaves a short list as it was', async () => {
    const { database, ids } = await withBooks(10)
    const short = database.db.selectFrom('books').select('id').where('id', 'in', ids.slice(0, 3)).compile()
    expect(short.sql).not.toContain('json_each')
    expect(short.parameters).toEqual(ids.slice(0, 3))

    // Up to the threshold too.
    const edge = Array.from({ length: LONG_LIST }, (_, index) => `X${index}`)
    expect(database.db.selectFrom('books').select('id').where('id', 'in', edge).compile().sql).not.toContain(
      'json_each',
    )
  })

  it('finds numbers as numbers', async () => {
    const { database } = await withBooks(10)
    await database.db.updateTable('books').set({ number: 3 }).where('id', '=', 'B000004').execute()
    const numbers = Array.from({ length: LONG_LIST + 1 }, (_, index) => index + 1)

    const found = await database.db.selectFrom('books').select('id').where('number', 'in', numbers).execute()
    expect(found.map((row) => row.id)).toEqual(['B000004'])
  })
})

describe('a long run of queries', () => {
  it('lets the rest of the server have its turn', async () => {
    const { database } = await withBooks(10)
    let turns = 0
    let running = true
    const count = (): void => {
      turns += 1
      if (running) setImmediate(count)
    }
    setImmediate(count)

    // Long enough that it would hold the thread for a noticeable time.
    const started = performance.now()
    while (performance.now() - started < 300) {
      await database.db.selectFrom('books').select('id').execute()
    }
    running = false

    // Without a turn handed over, nothing else would have run at all.
    expect(turns).toBeGreaterThan(5)
  })
})

describe('queueing many jobs', () => {
  it('takes them all, in more than one piece of work', async () => {
    const { database } = await withBooks(1)
    const jobs = Array.from({ length: 2_345 }, (_, index) => ({
      type: 'AnalyzeBook',
      uniqueKey: `ANALYZE_BOOK_${index}`,
      payload: { bookId: String(index) },
    }))

    await enqueueJobs(database.db, jobs)
    // Asked for again, nothing is added.
    await enqueueJobs(database.db, jobs.slice(0, 700))

    const rows = await database.db.selectFrom('jobs').select(['unique_key', 'payload']).execute()
    expect(rows).toHaveLength(2_345)
    expect(JSON.parse(rows.find((row) => row.unique_key === 'ANALYZE_BOOK_2344')!.payload)).toEqual({ bookId: '2344' })
  })
})
