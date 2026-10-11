import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { DB } from './schema.js'

export interface Database {
  db: Kysely<DB>
  /** Raw handle, for pragmas and anything Kysely does not cover. */
  sqlite: BetterSqlite3.Database
  close(): Promise<void>
}

/**
 * Open (or create) the SQLite database.
 *
 * Pragmas mirror Komga's connection setup: WAL journaling, foreign keys on and
 * a busy timeout so concurrent readers/writers do not fail immediately.
 */
export function createDatabase(file: string): Database {
  // better-sqlite3 refuses to open a database in a directory that does not exist.
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })

  const sqlite = new BetterSqlite3(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })

  return {
    db,
    sqlite,
    close: async () => {
      await db.destroy()
    },
  }
}
