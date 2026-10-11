import type { Kysely } from 'kysely'
import type { DB } from './schema.js'

export interface Migration {
  /** Sortable identifier, e.g. `0001_server_settings`. */
  id: string
  up(db: Kysely<DB>): Promise<void>
}

export interface MigrateResult {
  /** Ids of the migrations applied during this run. */
  applied: string[]
}

/**
 * Apply pending migrations in id order, recording each in `schema_migrations`.
 *
 * Safe to run repeatedly: already-applied migrations are skipped.
 */
export async function migrate(db: Kysely<DB>, migrations: readonly Migration[]): Promise<MigrateResult> {
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .execute()

  const rows = await db.selectFrom('schema_migrations').select('id').execute()
  const done = new Set(rows.map((row) => row.id))

  const applied: string[] = []
  for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (done.has(migration.id)) continue
    await migration.up(db)
    await db
      .insertInto('schema_migrations')
      .values({ id: migration.id, applied_at: new Date().toISOString() })
      .execute()
    applied.push(migration.id)
  }

  return { applied }
}
