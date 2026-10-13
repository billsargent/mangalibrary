/**
 * Where the server keeps its data, and carrying an install over from where it
 * used to.
 *
 * Early versions kept their database in `~/.komga`, which is Komga's own
 * directory: on a machine that also runs Komga the two would meet in one file.
 * The data now lives in `~/.mangalibrary`, and an install that started out in
 * the old place is moved across the first time it starts.
 */

import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

export const DATA_DIR_NAME = '.mangalibrary'
const LEGACY_DIR_NAME = '.komga'

/** The data directory used when none is named. */
export function defaultDataDir(home: string): string {
  return join(home, DATA_DIR_NAME)
}

/**
 * Whether a database file is one this server made.
 *
 * Komga's database is called `database.sqlite` too, so the name says nothing.
 * What tells them apart is the table this server records its migrations in,
 * which Komga does not have. A file that cannot be read is not ours.
 */
export function isOurDatabase(file: string): boolean {
  if (!existsSync(file)) return false
  let sqlite: BetterSqlite3.Database | undefined
  try {
    sqlite = new BetterSqlite3(file, { readonly: true, fileMustExist: true })
    const row = sqlite
      .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .get()
    return row !== undefined
  } catch {
    return false
  } finally {
    sqlite?.close()
  }
}

export type Adoption =
  /** Nothing to do: the new directory is there, or there was nothing to bring. */
  | { outcome: 'NONE' }
  | { outcome: 'MOVED'; from: string; to: string }
  /** The old directory is ours and could not be moved, so it is still in use. */
  | { outcome: 'KEPT'; dir: string; reason: string }

/**
 * Move an install from `~/.komga` to `~/.mangalibrary`, when there is one to move.
 *
 * Only when the new directory does not exist yet and the old one holds a database
 * of ours: a real Komga install is recognised by its database and never touched.
 * The directory is renamed as a whole, which is instant and loses nothing. If it
 * cannot be - another program has it open - the old directory goes on being used,
 * so that a start never comes up with an empty library.
 */
export function adoptLegacyDataDir(home: string): Adoption {
  const current = defaultDataDir(home)
  const legacy = join(home, LEGACY_DIR_NAME)
  if (existsSync(current) || !isOurDatabase(join(legacy, 'database.sqlite'))) return { outcome: 'NONE' }

  try {
    renameSync(legacy, current)
    return { outcome: 'MOVED', from: legacy, to: current }
  } catch (error) {
    return { outcome: 'KEPT', dir: legacy, reason: String(error) }
  }
}
