import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDatabase } from './index.js'
import { migrate } from './migrate.js'
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
    expect(applied.applied).toEqual(['0015_page_hash', '0016_search_series_title_sort', '0017_job_requeued'])

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
