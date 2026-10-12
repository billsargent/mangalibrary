import { describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { isLastAdministrator } from './access.js'
import { hashPassword } from './passwords.js'

/** A database holding the users given, by id, with their roles. */
async function usersDatabase(roles: Record<string, string[]>): Promise<Database> {
  const database = createDatabase(':memory:')
  await migrate(database.db, migrations)
  const now = new Date().toISOString()

  await database.db
    .insertInto('users')
    .values(
      Object.entries(roles).map(([id, list]) => ({
        id,
        email: `${id.toLowerCase()}@example.com`,
        password: hashPassword('secret'),
        roles: JSON.stringify(list),
        shared_all_libraries: 1,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      })),
    )
    .execute()
  return database
}

/**
 * The guard that keeps an instance from being left with nobody able to administer
 * it.
 *
 * It is tested here rather than through the API because the user routes already
 * refuse to let an administrator change their own account, which is the only way the
 * check could be reached: this is the second line, and it is what keeps the rule true
 * if that first one ever moves.
 */
describe('the last administrator', () => {
  it('is the only account that can administer the server', async () => {
    const alone = await usersDatabase({ U1: ['ADMIN', 'PAGE_STREAMING'], U2: ['PAGE_STREAMING'] })
    expect(await isLastAdministrator(alone.db, 'U1')).toBe(true)
    expect(await isLastAdministrator(alone.db, 'U2')).toBe(false)
    await alone.close()
  })

  it('is nobody when a second administrator exists', async () => {
    const two = await usersDatabase({ U1: ['ADMIN'], U2: ['ADMIN'] })
    expect(await isLastAdministrator(two.db, 'U1')).toBe(false)
    await two.close()
  })

  it('is nobody when there is no administrator at all', async () => {
    const none = await usersDatabase({ U1: ['PAGE_STREAMING'] })
    expect(await isLastAdministrator(none.db, 'U1')).toBe(false)
    await none.close()
  })

  it('is not fooled by a roles column that cannot be read', async () => {
    const broken = await usersDatabase({ U1: ['ADMIN'], U2: [] })
    await broken.db.updateTable('users').set({ roles: 'not json' }).where('id', '=', 'U2').execute()

    // The unreadable account grants nothing, so the readable one is still the last.
    expect(await isLastAdministrator(broken.db, 'U1')).toBe(true)
    await broken.close()
  })
})
