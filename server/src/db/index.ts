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

/** Cap on the compiled-pattern cache, so a client cannot grow it without bound. */
const REGEXP_CACHE_LIMIT = 128

/**
 * SQLite has no `REGEXP` operator of its own, but Komga's `search_regex`
 * parameter needs one. SQLite calls this once per row, so compiled patterns are
 * cached. Callers validate the pattern first - a throw here surfaces as a query
 * error rather than a clean 400.
 */
function installRegexp(sqlite: BetterSqlite3.Database): void {
  const cache = new Map<string, RegExp>()
  sqlite.function('regexp', { deterministic: true }, (pattern: string, value: unknown) => {
    if (value === null || value === undefined) return 0
    let compiled = cache.get(pattern)
    if (compiled === undefined) {
      if (cache.size >= REGEXP_CACHE_LIMIT) cache.clear()
      compiled = new RegExp(pattern, 'i')
      cache.set(pattern, compiled)
    }
    return compiled.test(String(value)) ? 1 : 0
  })
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
  installRegexp(sqlite)

  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })

  return {
    db,
    sqlite,
    close: async () => {
      await db.destroy()
    },
  }
}
