import { hashApiKey } from '../auth/users.js'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase } from './index.js'
import { migrate, type Migration } from './migrate.js'
import { migrations } from './migrations/index.js'

function expectedMigrationIds(): string[] {
  return migrations.map((migration) => migration.id)
}

describe('migrate', () => {
  it('applies pending migrations and is idempotent', async () => {
    const database = createDatabase(':memory:')

    const first = await migrate(database.db, migrations)
    expect(first.applied).toEqual(expectedMigrationIds())

    const second = await migrate(database.db, migrations)
    expect(second.applied).toEqual([])

    const result = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(database.db)
    const tables = result.rows.map((row) => row.name)
    expect(tables).toContain('schema_migrations')
    expect(tables).toContain('server_settings')

    await database.close()
  })

  it('enables foreign keys and WAL', async () => {
    const database = createDatabase(':memory:')
    const foreignKeys = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(database.db)
    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1)
    await database.close()
  })

  it('says what is waiting and each step as it finishes, and nothing when there is none', async () => {
    const database = createDatabase(':memory:')
    const told: unknown[] = []
    const progress = {
      onPending: (ids: readonly string[]) => told.push(['pending', [...ids]]),
      onStep: (id: string, milliseconds: number) => told.push(['step', id, milliseconds >= 0]),
    }

    await migrate(database.db, migrations, progress)
    expect(told).toEqual([
      ['pending', expectedMigrationIds()],
      ...expectedMigrationIds().map((id) => ['step', id, true]),
    ])

    told.length = 0
    await migrate(database.db, migrations, progress)
    expect(told).toEqual([])
    await database.close()
  })

  it('records migration ids in order', async () => {
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const rows = await database.db.selectFrom('schema_migrations').selectAll().orderBy('id').execute()
    expect(rows.map((row) => row.id)).toEqual(expectedMigrationIds())
    expect(rows[0]?.applied_at).toBeTruthy()
    await database.close()
  })

  it('has a contiguous, ordered migration registry', () => {
    const ids = migrations.map((migration) => migration.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('moves duplicate-page rows into the shape the API reads', async () => {
    const database = createDatabase(':memory:')
    // Up to, but not including, the reshape, so the old shape can be filled.
    await migrate(
      database.db,
      migrations.filter((migration) => migration.id < '0015_page_hash'),
    )

    // A hash judged once per media type, as a database from before mid-2023 held it,
    // with one hash naming two books and pages.
    const now = new Date().toISOString()
    await sql`insert into libraries (id, name, root, created_date, last_modified_date)
      values ('L1', 'Main', '/library', ${now}, ${now})`.execute(database.db)
    await sql`insert into series (id, library_id, name, url, file_last_modified, created_date, last_modified_date)
      values ('S1', 'L1', 'Akira', 'akira', ${now}, ${now}, ${now})`.execute(database.db)
    for (const id of ['B1', 'B2']) {
      await sql`insert into books (id, series_id, library_id, name, url, file_last_modified, file_size, number, created_date, last_modified_date)
        values (${id}, 'S1', 'L1', 'Volume', ${id}, ${now}, 0, 1, ${now}, ${now})`.execute(database.db)
    }
    await sql`insert into page_hash (hash, book_id, page_number, file_size, delete_count)
      values ('same', 'B1', 1, 512, 2), ('same', 'B2', 1, 512, 3), ('other', 'B1', 2, 999, 0)`.execute(database.db)
    await sql`insert into page_hash_match (hash, book_id, page_number) values ('other', 'B1', 2)`.execute(database.db)
    await sql`insert into page_hash_unknown (hash, file_size, created_date, last_modified_date)
      values ('mystery', 4096, ${now}, ${now})`.execute(database.db)

    const applied = await migrate(database.db, migrations)
    expect(applied.applied).toEqual([
      '0015_page_hash',
      '0016_search_series_title_sort',
      '0017_job_requeued',
      '0018_content_version',
      '0019_pdf_page_size',
      '0020_sidecars',
      '0021_pageless_books',
      '0022_job_queue_indexes',
      '0023_listing_indexes',
      '0024_referential_indexes',
      '0025_hashed_api_keys',
      '0026_schema_repairs',
      '0027_title_sort_key',
    ])

    // One row per hash, keeping the largest size and the highest delete count, and
    // importing a hash as "known, and remove nothing" because its action was never
    // stored here.
    const hashes = await database.db.selectFrom('page_hash').selectAll().orderBy('hash').execute()
    expect(hashes).toEqual([
      {
        hash: 'other',
        size: 999,
        action: 'IGNORE',
        delete_count: 0,
        created_date: expect.any(String),
        last_modified_date: expect.any(String),
      },
      {
        hash: 'same',
        size: 512,
        action: 'IGNORE',
        delete_count: 3,
        created_date: expect.any(String),
        last_modified_date: expect.any(String),
      },
    ])

    // The tables the API derives its answers from are gone, and a page can hold its
    // own hash.
    const tables = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(database.db)
    const names = tables.rows.map((row) => row.name)
    expect(names).toContain('page_hash_thumbnail')
    expect(names).not.toContain('page_hash_match')
    expect(names).not.toContain('page_hash_unknown')

    const columns = await sql<{ name: string }>`pragma table_info(media_page)`.execute(database.db)
    expect(columns.rows.map((row) => row.name)).toContain('file_hash')

    await database.close()
  })
})

describe('API keys kept as hashes', () => {
  it('replaces each stored key by its hash, and leaves a hash as it is', async () => {
    const database = createDatabase(':memory:')
    await migrate(
      database.db,
      migrations.filter((migration) => migration.id < '0025_hashed_api_keys'),
    )
    const now = new Date().toISOString()
    await database.db
      .insertInto('users')
      .values({ id: 'U1', email: 'a@example.com', password: 'x', created_date: now, last_modified_date: now } as never)
      .execute()
    const already = 'f'.repeat(128)
    await database.db
      .insertInto('user_api_keys')
      .values([
        { id: 'K1', user_id: 'U1', key: 'plain-key', comment: 'one', created_date: now, last_modified_date: now },
        { id: 'K2', user_id: 'U1', key: already, comment: 'two', created_date: now, last_modified_date: now },
      ])
      .execute()

    await migrate(database.db, migrations)
    const keys = await database.db.selectFrom('user_api_keys').select(['id', 'key']).orderBy('id').execute()
    expect(keys).toEqual([
      { id: 'K1', key: hashApiKey('plain-key') },
      { id: 'K2', key: already },
    ])
    await database.close()
  })
})

describe('a migration stopped part-way', () => {
  it('leaves nothing behind, and the next start runs it again from the beginning', async () => {
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)

    let fail = true
    const halfway: Migration = {
      id: '9999_halfway',
      up: async (db) => {
        await sql`create table made_halfway (id text primary key)`.execute(db)
        await sql`alter table made_halfway add column extra text`.execute(db)
        if (fail) throw new Error('the server was stopped')
      },
    }

    await expect(migrate(database.db, [...migrations, halfway])).rejects.toThrow(/stopped/)
    // Neither the table nor the record of the migration: as if it had not begun.
    const tables = await sql<{ name: string }>`select name from sqlite_master where name = 'made_halfway'`.execute(
      database.db,
    )
    expect(tables.rows).toEqual([])
    const recorded = await database.db
      .selectFrom('schema_migrations')
      .select('id')
      .where('id', '=', '9999_halfway')
      .execute()
    expect(recorded).toEqual([])

    // The next start: no "already exists", no "duplicate column".
    fail = false
    expect((await migrate(database.db, [...migrations, halfway])).applied).toEqual(['9999_halfway'])
    await database.close()
  })
})

describe('the schema repairs', () => {
  it('takes a cover with its owner, removes the ones left behind, and dates page hashes like the rest', async () => {
    const database = createDatabase(':memory:')
    await migrate(
      database.db,
      migrations.filter((migration) => migration.id < '0026_schema_repairs'),
    )
    const now = '2026-01-01T00:00:00.000Z'
    const db = database.db
    await db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'L', root: '/l', created_date: now, last_modified_date: now })
      .execute()
    await db
      .insertInto('series')
      .values({
        id: 'S1',
        library_id: 'L1',
        name: 'S',
        url: 'file:///l/s',
        file_last_modified: now,
        created_date: now,
        last_modified_date: now,
      })
      .execute()
    const cover = (id: string, ownerType: string, ownerId: string) => ({
      id,
      owner_type: ownerType,
      owner_id: ownerId,
      type: 'GENERATED',
      page: 1,
      selected: 1,
      media_type: 'image/jpeg',
      width: 1,
      height: 1,
      file_size: 1,
      thumbnail: Buffer.from([1]),
      created_date: now,
      last_modified_date: now,
    })
    await db
      .insertInto('thumbnails')
      .values([cover('T1', 'SERIES', 'S1'), cover('T2', 'BOOK', 'gone')] as never)
      .execute()
    await sql`insert into page_hash (hash, size, action, delete_count, created_date, last_modified_date)
      values ('h', 1, 'IGNORE', 0, '2026-10-14 10:00:00', '2026-10-14 10:00:00')`.execute(db)

    await migrate(db, migrations)

    // The cover of a book that is gone, gone; the series' cover kept until the series goes.
    expect((await db.selectFrom('thumbnails').select('id').execute()).map((row) => row.id)).toEqual(['T1'])
    await db.deleteFrom('series').where('id', '=', 'S1').execute()
    expect(await db.selectFrom('thumbnails').select('id').execute()).toEqual([])

    expect(await db.selectFrom('page_hash').select(['created_date', 'last_modified_date']).execute()).toEqual([
      { created_date: '2026-10-14T10:00:00.000Z', last_modified_date: '2026-10-14T10:00:00.000Z' },
    ])

    const indexes = (
      await sql<{ name: string }>`select name from sqlite_master where type = 'index'`.execute(db)
    ).rows.map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx__read_progress__book_id',
        'idx__read_progress_series__series_id',
        'idx__user_library_sharing__library_id',
      ]),
    )
    expect(indexes).not.toContain('idx__thumbnails__owner')
    await database.close()
  })
})

describe('the key series are sorted by', () => {
  it('ignores case and accents, follows every change of title, and leaves the search index whole', async () => {
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const db = database.db
    const now = '2026-01-01T00:00:00.000Z'
    await db
      .insertInto('libraries')
      .values({ id: 'L1', name: 'L', root: '/l', created_date: now, last_modified_date: now })
      .execute()
    const titles = ['Zed', 'alpha', 'Élan', 'Beta', 'eagle']
    for (const [index, title] of titles.entries()) {
      const id = `S${index}`
      await db
        .insertInto('series')
        .values({
          id,
          library_id: 'L1',
          name: title,
          url: `file:///l/${index}`,
          file_last_modified: now,
          created_date: now,
          last_modified_date: now,
        })
        .execute()
      await db
        .insertInto('series_metadata')
        .values({ series_id: id, title, title_sort: title, created_date: now, last_modified_date: now })
        .execute()
    }
    const order = async () =>
      (
        await db
          .selectFrom('series_metadata')
          .select('title_sort')
          .orderBy('title_sort_key')
          .orderBy('series_id')
          .execute()
      ).map((row) => row.title_sort)
    expect(await order()).toEqual(['alpha', 'Beta', 'eagle', 'Élan', 'Zed'])

    // A changed title moves, and the search finds it by its new name and not its old.
    await db
      .updateTable('series_metadata')
      .set({ title_sort: 'Aardvark', title: 'Aardvark' })
      .where('series_id', '=', 'S0')
      .execute()
    expect((await order())[0]).toBe('Aardvark')
    const found = async (term: string) =>
      (
        await sql<{ series_id: string }>`select series_id from fts_series where fts_series match ${term}`.execute(db)
      ).rows.map((row) => row.series_id)
    expect(await found('aardvark')).toEqual(['S0'])
    expect(await found('zed')).toEqual([])
    expect(await found('beta')).toEqual(['S3'])
    await sql`insert into fts_series(fts_series) values('integrity-check')`.execute(db)
    await database.close()
  })
})
