import type { Kysely } from 'kysely'
import type { DB } from './schema.js'

export interface Migration {
  /** Sortable identifier, e.g. `0001_server_settings`. */
  id: string
  up(db: Kysely<DB>): Promise<void>
}

/** What a caller is told while migrations run, so that a long upgrade is not silent. */
export interface MigrateProgress {
  /** Before anything is done: the steps that are waiting, in the order they will run. */
  onPending?(ids: readonly string[]): void
  /** As each step finishes, with how long it took. */
  onStep?(id: string, milliseconds: number): void
}

export interface MigrateResult {
  /** Ids of the migrations applied during this run. */
  applied: string[]
}

/**
 * Apply pending migrations in id order, recording each in `schema_migrations`.
 *
 * Safe to run repeatedly: already-applied migrations are skipped.
 *
 * Each migration and the row that records it are one transaction. A migration
 * stopped part-way - the server killed, the disk full - leaves nothing behind, so
 * the next start runs it again from the beginning rather than meeting a table it
 * half made. And whether it has run is asked again inside that transaction, so
 * two servers started on one database at once do not both run it.
 */
export async function migrate(
  db: Kysely<DB>,
  migrations: readonly Migration[],
  progress: MigrateProgress = {},
): Promise<MigrateResult> {
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .execute()

  const rows = await db.selectFrom('schema_migrations').select('id').execute()
  const done = new Set(rows.map((row) => row.id))

  const pending = [...migrations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((migration) => !done.has(migration.id))
  if (pending.length > 0) progress.onPending?.(pending.map((migration) => migration.id))

  const applied: string[] = []
  for (const migration of pending) {
    const started = performance.now()
    const ran = await db.transaction().execute(async (trx) => {
      const already = await trx
        .selectFrom('schema_migrations')
        .select('id')
        .where('id', '=', migration.id)
        .executeTakeFirst()
      if (already) return false
      await migration.up(trx)
      await trx
        .insertInto('schema_migrations')
        .values({ id: migration.id, applied_at: new Date().toISOString() })
        .execute()
      return true
    })
    if (!ran) continue
    applied.push(migration.id)
    progress.onStep?.(migration.id, performance.now() - started)
  }

  return { applied }
}
