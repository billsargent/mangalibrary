import BetterSqlite3 from 'better-sqlite3'

export type LegacyRow = Record<string, unknown>

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

  /** Rows of a table (empty when the table is absent), with upper-cased keys. */
  rows(table: string): LegacyRow[] {
    if (!this.hasTable(table)) return []
    const raw = this.db.prepare(`select * from "${table.replaceAll('"', '""')}"`).all() as Record<string, unknown>[]
    return raw.map((row) => {
      const normalised: LegacyRow = {}
      for (const [key, value] of Object.entries(row)) normalised[key.toUpperCase()] = value
      return normalised
    })
  }

  close(): void {
    this.db.close()
  }
}
