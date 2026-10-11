import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'

export interface SessionStore {
  create(userId: string, ttlMs: number): Promise<string>
  get(id: string): Promise<string | undefined>
  destroy(id: string): Promise<void>
  purgeExpired(now?: number): Promise<number>
}

/** Sessions persisted in the `sessions` table. */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Kysely<DB>) {}

  async create(userId: string, ttlMs: number): Promise<string> {
    const id = randomBytes(32).toString('hex')
    const now = new Date()
    await this.db
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        data: '{}',
        expires_at: now.getTime() + ttlMs,
        created_date: now.toISOString(),
      })
      .execute()
    return id
  }

  async get(id: string): Promise<string | undefined> {
    const row = await this.db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) return undefined
    if (row.expires_at <= Date.now() || row.user_id === null) {
      await this.destroy(id)
      return undefined
    }
    return row.user_id
  }

  async destroy(id: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', id).execute()
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    const result = await this.db.deleteFrom('sessions').where('expires_at', '<=', now).executeTakeFirst()
    return Number(result.numDeletedRows ?? 0)
  }
}
