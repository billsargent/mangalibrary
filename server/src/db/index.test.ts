import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from './index.js'

describe('createDatabase', () => {
  it('creates missing parent directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-db-'))
    const file = join(dir, 'nested', 'deeper', 'database.sqlite')

    const database = createDatabase(file)
    expect(existsSync(file)).toBe(true)

    await database.close()
  })

  it('opens an in-memory database without touching the filesystem', async () => {
    const database = createDatabase(':memory:')
    const rows = database.sqlite.prepare('select 1 as value').all() as { value: number }[]
    expect(rows[0]?.value).toBe(1)
    await database.close()
  })
})
