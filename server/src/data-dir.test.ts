import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { adoptLegacyDataDir, defaultDataDir, isOurDatabase } from './data-dir.js'
import { createDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'

const home = () => mkdtempSync(join(tmpdir(), 'ml-home-'))

/** A database this server made, in a directory. */
async function ours(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const database = createDatabase(join(dir, 'database.sqlite'))
  await migrate(database.db, migrations)
  await database.db
    .insertInto('libraries')
    .values({ id: 'L1', name: 'Kept', root: '/books', created_date: 'now', last_modified_date: 'now' } as never)
    .execute()
  await database.close()
}

/** A database some other program made, as Komga's would be. */
function theirs(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const sqlite = new BetterSqlite3(join(dir, 'database.sqlite'))
  sqlite.exec('create table LIBRARY (ID text primary key, NAME text)')
  sqlite.close()
}

describe('telling our database from another', () => {
  it('knows one this server made', async () => {
    const dir = home()
    await ours(dir)
    expect(isOurDatabase(join(dir, 'database.sqlite'))).toBe(true)
  })

  it('does not take another program’s, a file that is no database, or nothing', () => {
    const dir = home()
    theirs(dir)
    expect(isOurDatabase(join(dir, 'database.sqlite'))).toBe(false)

    writeFileSync(join(dir, 'notes.sqlite'), 'not a database at all')
    expect(isOurDatabase(join(dir, 'notes.sqlite'))).toBe(false)
    expect(isOurDatabase(join(dir, 'missing.sqlite'))).toBe(false)
  })
})

describe('carrying an install over', () => {
  it('moves the old directory when it is ours, with everything in it', async () => {
    const dir = home()
    await ours(join(dir, '.komga'))
    writeFileSync(join(dir, '.komga', 'config.json'), '{"port":8080}')

    expect(adoptLegacyDataDir(dir)).toEqual({
      outcome: 'MOVED',
      from: join(dir, '.komga'),
      to: join(dir, '.mangalibrary'),
    })
    expect(existsSync(join(dir, '.komga'))).toBe(false)
    expect(readFileSync(join(defaultDataDir(dir), 'config.json'), 'utf8')).toBe('{"port":8080}')

    const database = createDatabase(join(defaultDataDir(dir), 'database.sqlite'))
    const libraries = await database.db.selectFrom('libraries').select('name').execute()
    await database.close()
    expect(libraries).toEqual([{ name: 'Kept' }])
  })

  it('leaves a real Komga directory exactly where it is', () => {
    const dir = home()
    theirs(join(dir, '.komga'))

    expect(adoptLegacyDataDir(dir)).toEqual({ outcome: 'NONE' })
    expect(existsSync(join(dir, '.komga', 'database.sqlite'))).toBe(true)
    expect(existsSync(join(dir, '.mangalibrary'))).toBe(false)
  })

  it('does nothing when the new directory is already there', async () => {
    const dir = home()
    await ours(join(dir, '.komga'))
    mkdirSync(join(dir, '.mangalibrary'))

    expect(adoptLegacyDataDir(dir)).toEqual({ outcome: 'NONE' })
    expect(existsSync(join(dir, '.komga', 'database.sqlite'))).toBe(true)
  })

  it('does nothing on a machine with neither', () => {
    expect(adoptLegacyDataDir(home())).toEqual({ outcome: 'NONE' })
  })
})
