import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { hashPassword } from '../auth/passwords.js'
import { requireAdmin, requireAuth, requireRole } from '../auth/session.js'
import { USER_ROLES, isUserRole, type AuthUser } from '../auth/types.js'
import { findUserById } from '../auth/users.js'
import type { DB } from '../db/schema.js'
import { nextTsid } from '../tsid.js'
import { springPage, toUserDto, type UserDto } from './dto.js'
import type { RouteOptions } from './libraries.js'

interface AgeRestrictionBody {
  age?: number
  restriction?: string
}

function currentUser(req: FastifyRequest): AuthUser {
  const user = req.user
  if (!user) throw new Error('unauthenticated')
  return user
}

function rolesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(String).filter(isUserRole)
}

async function loadLibrarySharing(db: Kysely<DB>, userId: string) {
  const [row, sharing] = await Promise.all([
    db.selectFrom('users').select('shared_all_libraries').where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('user_library_sharing').select('library_id').where('user_id', '=', userId).execute(),
  ])
  return {
    sharedAllLibraries: row?.shared_all_libraries !== 0,
    sharedLibrariesIds: sharing.map((entry) => entry.library_id),
  }
}

async function writeLibrarySharing(db: Kysely<DB>, userId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') return
  const shared = value as { all?: unknown; libraryIds?: unknown }
  if (typeof shared.all === 'boolean') {
    await db
      .updateTable('users')
      .set({ shared_all_libraries: shared.all ? 1 : 0 })
      .where('id', '=', userId)
      .execute()
  }
  if (Array.isArray(shared.libraryIds)) {
    await db.deleteFrom('user_library_sharing').where('user_id', '=', userId).execute()
    const ids = shared.libraryIds.map(String).filter((id) => id !== '')
    if (ids.length > 0) {
      await db
        .insertInto('user_library_sharing')
        .values(ids.map((libraryId) => ({ user_id: userId, library_id: libraryId })))
        .execute()
    }
  }
}

async function writeUserSharing(db: Kysely<DB>, userId: string, body: Record<string, unknown>): Promise<void> {
  if (!('labelsAllow' in body) && !('labelsExclude' in body)) return
  const allow = Array.isArray(body.labelsAllow) ? body.labelsAllow.map(String).filter((label) => label !== '') : []
  const exclude = Array.isArray(body.labelsExclude)
    ? body.labelsExclude.map(String).filter((label) => label !== '')
    : []

  await db.deleteFrom('user_sharing').where('user_id', '=', userId).execute()
  const rows = [
    ...exclude.map((label) => ({ user_id: userId, allow: 0, label })),
    ...allow.filter((label) => !exclude.includes(label)).map((label) => ({ user_id: userId, allow: 1, label })),
  ]
  if (rows.length > 0) await db.insertInto('user_sharing').values(rows).execute()
}

async function writeAgeRestriction(db: Kysely<DB>, userId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') return
  const restriction = value as AgeRestrictionBody
  if (restriction.restriction === 'NONE') {
    await db
      .updateTable('users')
      .set({ age_restriction: null, age_restriction_allow_only: null })
      .where('id', '=', userId)
      .execute()
    return
  }
  if (typeof restriction.age !== 'number') return
  await db
    .updateTable('users')
    .set({
      age_restriction: restriction.age,
      age_restriction_allow_only: restriction.restriction === 'EXCLUDE' ? 0 : 1,
    })
    .where('id', '=', userId)
    .execute()
}

export async function registerUserRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  const toDto = async (user: AuthUser): Promise<UserDto> => toUserDto(user, await loadLibrarySharing(db, user.id))

  app.get('/api/v2/users', { preHandler: requireAdmin }, async () => {
    const rows = await db.selectFrom('users').select('id').orderBy('email').execute()
    const users: UserDto[] = []
    for (const row of rows) {
      const user = await findUserById(db, row.id)
      if (user) users.push(await toDto(user))
    }
    return users
  })

  app.post('/api/v2/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || !password) return reply.code(400).send({ message: 'email and password are required' })

    const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
    if (existing) return reply.code(400).send({ message: 'email already in use' })

    const now = new Date().toISOString()
    const id = nextTsid()
    await db
      .insertInto('users')
      .values({
        id,
        email,
        password: hashPassword(password),
        roles: JSON.stringify(rolesFrom(body.roles)),
        shared_all_libraries: 0,
        age_restriction: null,
        age_restriction_allow_only: null,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    await writeLibrarySharing(db, id, body.sharedLibraries)
    await writeUserSharing(db, id, body)
    await writeAgeRestriction(db, id, body.ageRestriction)

    const user = await findUserById(db, id)
    return toDto(user!)
  })

  app.get('/api/v2/users/me', { preHandler: requireAuth }, async (req) => toDto(currentUser(req)))

  app.get<{ Params: { id: string } }>('/api/v2/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const user = await findUserById(db, req.params.id)
    if (!user) return reply.code(404).send({ message: 'User not found' })
    return toDto(user)
  })

  app.patch<{ Params: { id: string } }>('/api/v2/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await db.selectFrom('users').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'User not found' })

    const body = (req.body ?? {}) as Record<string, unknown>
    if ('roles' in body) {
      await db
        .updateTable('users')
        .set({ roles: JSON.stringify(rolesFrom(body.roles)), last_modified_date: new Date().toISOString() })
        .where('id', '=', req.params.id)
        .execute()
    }
    await writeLibrarySharing(db, req.params.id, body.sharedLibraries)
    await writeUserSharing(db, req.params.id, body)
    await writeAgeRestriction(db, req.params.id, body.ageRestriction)
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/api/v2/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await db.selectFrom('users').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'User not found' })
    await db.deleteFrom('users').where('id', '=', req.params.id).execute()
    return reply.code(204).send()
  })

  const changePassword = (path: string, adminOnly: boolean) => {
    app.patch<{ Params: { id: string } }>(
      path,
      { preHandler: adminOnly ? requireAdmin : requireAuth },
      async (req, reply) => {
        const userId = adminOnly ? req.params.id : currentUser(req).id
        const body = (req.body ?? {}) as Record<string, unknown>
        const password = typeof body.password === 'string' ? body.password : ''
        if (!password) return reply.code(400).send({ message: 'password is required' })

        const existing = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
        if (!existing) return reply.code(404).send({ message: 'User not found' })

        await db
          .updateTable('users')
          .set({ password: hashPassword(password), last_modified_date: new Date().toISOString() })
          .where('id', '=', userId)
          .execute()
        return reply.code(204).send()
      },
    )
  }
  changePassword('/api/v2/users/:id/password', true)
  changePassword('/api/v2/users/me/password', false)

  // ------------------------------------------------------------------ api keys
  app.get('/api/v2/users/me/api-keys', { preHandler: requireAuth }, async (req) => {
    const rows = await db
      .selectFrom('user_api_keys')
      .selectAll()
      .where('user_id', '=', currentUser(req).id)
      .orderBy('created_date')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      key: row.key,
      comment: row.comment,
      createdDate: row.created_date,
      lastModifiedDate: row.last_modified_date,
    }))
  })

  app.post('/api/v2/users/me/api-keys', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
    if (!comment) return reply.code(400).send({ message: 'comment is required' })

    const now = new Date().toISOString()
    const id = nextTsid()
    const key = randomBytes(16).toString('hex')
    await db
      .insertInto('user_api_keys')
      .values({
        id,
        user_id: currentUser(req).id,
        key,
        comment,
        created_date: now,
        last_modified_date: now,
      })
      .execute()

    return {
      id,
      userId: currentUser(req).id,
      key,
      comment,
      createdDate: now,
      lastModifiedDate: now,
    }
  })

  app.delete<{ Params: { keyId: string } }>(
    '/api/v2/users/me/api-keys/:keyId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const existing = await db
        .selectFrom('user_api_keys')
        .select('id')
        .where('id', '=', req.params.keyId)
        .where('user_id', '=', currentUser(req).id)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'API key not found' })
      await db.deleteFrom('user_api_keys').where('id', '=', req.params.keyId).execute()
      return reply.code(204).send()
    },
  )

  // ------------------------------------------------------- authentication activity
  const activityDto = (row: {
    user_id: string | null
    email: string | null
    user_agent: string | null
    ip: string | null
    success: number
    error: string | null
    date_time: string
  }) => ({
    userId: row.user_id,
    email: row.email,
    userAgent: row.user_agent,
    ip: row.ip,
    success: row.success === 1,
    error: row.error,
    dateTime: row.date_time,
  })

  app.get('/api/v2/users/authentication-activity', { preHandler: requireAdmin }, async (req) => {
    const query = (req.query ?? {}) as { page?: number; size?: number; unpaged?: boolean }
    const page = Number.isFinite(query.page) ? Number(query.page) : 0
    const size = Number.isFinite(query.size) ? Number(query.size) : 20

    const total = await db
      .selectFrom('authentication_activity')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirst()
    const rows = await db
      .selectFrom('authentication_activity')
      .selectAll()
      .orderBy('date_time', 'desc')
      .limit(size)
      .offset(page * size)
      .execute()

    return springPage(rows.map(activityDto), page, size, Number(total?.count ?? 0))
  })

  app.get('/api/v2/users/me/authentication-activity', { preHandler: requireAuth }, async (req) => {
    const query = (req.query ?? {}) as { page?: number; size?: number }
    const page = Number.isFinite(query.page) ? Number(query.page) : 0
    const size = Number.isFinite(query.size) ? Number(query.size) : 20
    const userId = currentUser(req).id

    const total = await db
      .selectFrom('authentication_activity')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirst()
    const rows = await db
      .selectFrom('authentication_activity')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('date_time', 'desc')
      .limit(size)
      .offset(page * size)
      .execute()

    return springPage(rows.map(activityDto), page, size, Number(total?.count ?? 0))
  })

  app.get<{ Params: { id: string } }>(
    '/api/v2/users/:id/authentication-activity/latest',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db
        .selectFrom('authentication_activity')
        .selectAll()
        .where('user_id', '=', req.params.id)
        .orderBy('date_time', 'desc')
        .limit(1)
        .executeTakeFirst()
      if (!row) return reply.code(404).send({ message: 'No activity found' })
      return activityDto(row)
    },
  )

  // Exposed so `USER_ROLES` is not dropped by tree-shaking in tests.
  void requireRole
  void USER_ROLES
}
