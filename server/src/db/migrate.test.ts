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

    const result = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(
      database.db,
    )
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
})
