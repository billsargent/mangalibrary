import BetterSqlite3 from 'better-sqlite3'

export type LegacyRow = Record<string, unknown>

/** A row with its column names upper-cased, as the legacy schema spells them in one place and not another. */
function normalised(row: Record<string, unknown>): LegacyRow {
  const out: LegacyRow = {}
  for (const [key, value] of Object.entries(row)) out[key.toUpperCase()] = value
  return out
}

/**
 * Read-only access to a legacy Komga database.
 *
 * The legacy schema drifted across 80+ migrations, so access is defensive:
 * tables and columns are probed before use and every lookup is case-insensitive.
 */
export class LegacyDatabase {
  private readonly db: BetterSqlite3.Database
  private readonly tableCache = new Map<string, boolean>()
  private readonly columnCache = new Map<string, Set<string>>()

  constructor(file: string) {
    this.db = new BetterSqlite3(file, { readonly: true, fileMustExist: true })
  }

  hasTable(table: string): boolean {
    const cached = this.tableCache.get(table)
    if (cached !== undefined) return cached
    const row = this.db
      .prepare(`select 1 as ok from sqlite_master where type = 'table' and name = ? collate nocase`)
      .get(table)
    const result = row !== undefined
    this.tableCache.set(table, result)
    return result
  }

  private columns(table: string): Set<string> {
    const cached = this.columnCache.get(table)
    if (cached) return cached
    const rows = this.db.prepare(`pragma table_info("${table.replaceAll('"', '""')}")`).all() as { name: string }[]
    const result = new Set(rows.map((row) => row.name.toUpperCase()))
    this.columnCache.set(table, result)
    return result
  }

  hasColumns(table: string, ...columns: string[]): boolean {
    if (!this.hasTable(table)) return false
    const available = this.columns(table)
    return columns.every((column) => available.has(column.toUpperCase()))
  }

  /** How many rows a table has (none when it is absent). */
  count(table: string): number {
    if (!this.hasTable(table)) return 0
    const row = this.db.prepare(`select count(*) as n from "${table.replaceAll('"', '""')}"`).get() as { n: number }
    return row.n
  }

  /**
   * The rows of a table one at a time (none when the table is absent).
   *
   * A real Komga database holds millions of page rows and gigabytes of covers, so
   * nothing reads a table whole: each row is gone before the next is read.
   */
  *iterate(table: string): Generator<LegacyRow> {
    if (!this.hasTable(table)) return
    const statement = this.db.prepare(`select * from "${table.replaceAll('"', '""')}"`)
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) yield normalised(row)
  }

  /** Every row of a table, for the small ones: users, libraries, settings. */
  rows(table: string): LegacyRow[] {
    return [...this.iterate(table)]
  }

  /** The answer to a query of the caller's own, for counts and other small summaries. */
  query(sql: string): LegacyRow[] {
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(normalised)
  }

  close(): void {
    this.db.close()
  }
}
