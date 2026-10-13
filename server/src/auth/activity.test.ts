import { describe, expect, it } from 'vitest'

import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'
import { removeOldAuthenticationActivity } from './activity.js'

describe('the record of who signed in', () => {
  it('is kept for a month and no longer', async () => {
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const now = new Date('2030-06-15T12:00:00.000Z')
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

    await database.db
      .insertInto('authentication_activity')
      .values(
        [1, 29, 31, 400].map((days) => ({
          id: 'A' + String(days),
          user_id: null,
          email: `seen-${days}-days-ago@example.com`,
          ip: '127.0.0.1',
          user_agent: 'test',
          success: 1,
          error: null,
          date_time: daysAgo(days),
        })) as never,
      )
      .execute()

    expect(await removeOldAuthenticationActivity(database.db, now)).toBe(2)
    const left = await database.db.selectFrom('authentication_activity').select('email').orderBy('date_time').execute()
    expect(left.map((row) => row.email)).toEqual(['seen-29-days-ago@example.com', 'seen-1-days-ago@example.com'])

    // Nothing more to remove the next day it is asked.
    expect(await removeOldAuthenticationActivity(database.db, now)).toBe(0)
    await database.close()
  })
})
