import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { hashPassword } from '../auth/passwords.js'
import { isLastAdministrator } from '../auth/access.js'
import { requireAdmin, requireAuth, requireRole } from '../auth/session.js'
import { USER_ROLES, isUserRole, type AuthUser, type UserRole } from '../auth/types.js'
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

/**
 * Read a role list from a request body.
 *
 * Every value has to be one of the roles this server knows: a client that sends a
 * typo is told which value was wrong, rather than being given an account with fewer
 * permissions than it asked for. A value that is not an array at all is refused for
 * the same reason - answering a bare string by stripping every role is the worst
 * possible reading of it. An empty array is allowed, as the reference allows it: an
 * account with no roles can sign in and read its own profile, and nothing else.
 */
function rolesFrom(value: unknown): { roles: UserRole[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: 'roles must be an array of role names' }
  }

  const roles: UserRole[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isUserRole(entry)) {
      return { error: `unknown role: ${String(entry)}` }
    }
    if (!roles.includes(entry)) roles.push(entry)
  }
  return { roles }
}

/**
 * Whether a newly created user sees every library.
 *
 * The reference defaults to yes when the request says nothing about libraries: the
 * field was added after the endpoint existed, and a user created before that saw
 * everything. Defaulting to no would quietly take away access instead.
 */
function sharedAllLibrariesOnCreate(value: unknown): number {
  const shared = (value ?? {}) as { all?: unknown }
  return shared.all === false ? 0 : 1
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
    const requested = shared.libraryIds.map(String).filter((id) => id !== '')
    // Only libraries that exist are shared: a row for an id that is gone would
    // be a share nobody can ever see.
    const known =
      requested.length === 0 ? [] : await db.selectFrom('libraries').select('id').where('id', 'in', requested).execute()
    const ids = known.map((row) => row.id)
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

/**
 * Everything that decides what a user may see or do, as one comparable value.
 *
 * A session carries the permissions it was opened with, so a change to any of
 * this has to end the session - and an update that changes none of it must not.
 * Comparing one string per update is simpler than tracking each field.
 */
async function permissionSnapshot(db: Kysely<DB>, userId: string): Promise<string> {
  const [row, libraries, labels] = await Promise.all([
    db
      .selectFrom('users')
      .select(['roles', 'shared_all_libraries', 'age_restriction', 'age_restriction_allow_only'])
      .where('id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('user_library_sharing')
      .select('library_id')
      .where('user_id', '=', userId)
      .orderBy('library_id')
      .execute(),
    db.selectFrom('user_sharing').select(['allow', 'label']).where('user_id', '=', userId).orderBy('label').execute(),
  ])

  return JSON.stringify({
    roles: row?.roles ?? '',
    sharedAllLibraries: row?.shared_all_libraries ?? 0,
    ageRestriction: row?.age_restriction ?? null,
    ageRestrictionAllowOnly: row?.age_restriction_allow_only ?? null,
    libraries: libraries.map((entry) => entry.library_id),
    labels: labels.map((entry) => `${entry.allow}:${entry.label}`),
  })
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

    // The role list is required, as it is in the contract: an account with no roles
    // can sign in and do nothing but read its own profile.
    const parsed = rolesFrom(body.roles)
    if ('error' in parsed) {
      return reply.code(400).send({ message: parsed.error })
    }
    const roles = parsed.roles

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
        roles: JSON.stringify(roles),
        shared_all_libraries: sharedAllLibrariesOnCreate(body.sharedLibraries),
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
    // The reference refuses this too, and for a good reason: an admin who could
    // change their own roles here could remove their own access and leave the
    // instance with nobody able to administer it. Their own account is reachable
    // through the `me` routes.
    if (req.params.id === currentUser(req).id) {
      return reply.code(403).send({ message: 'You cannot change your own account through this endpoint' })
    }

    const existing = await db.selectFrom('users').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'User not found' })

    const before = await permissionSnapshot(db, req.params.id)
    const body = (req.body ?? {}) as Record<string, unknown>
    if ('roles' in body) {
      const parsed = rolesFrom(body.roles)
      if ('error' in parsed) return reply.code(400).send({ message: parsed.error })

      // Taking the administration away from the only account that has it would leave
      // an instance nobody can administer, and no way back in through the API. An
      // administrator cannot change their own account here, so this cannot happen by
      // the route as it stands; it is the guard that keeps it true if that changes.
      if (!parsed.roles.includes('ADMIN') && (await isLastAdministrator(db, req.params.id))) {
        return reply.code(403).send({ message: 'The last administrator cannot stop being one' })
      }

      await db
        .updateTable('users')
        .set({ roles: JSON.stringify(parsed.roles), last_modified_date: new Date().toISOString() })
        .where('id', '=', req.params.id)
        .execute()
    }
    await writeLibrarySharing(db, req.params.id, body.sharedLibraries)
    await writeUserSharing(db, req.params.id, body)
    await writeAgeRestriction(db, req.params.id, body.ageRestriction)

    // A live session carries the permissions it was opened with, so a change to
    // what the user may see has to end it. An update that changes nothing
    // readable leaves the sessions alone.
    if ((await permissionSnapshot(db, req.params.id)) !== before) {
      opts.events.publish({ name: 'SessionExpired', data: { userId: req.params.id }, userId: req.params.id })
    }
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/api/v2/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    // Same reason as the update above: an admin deleting their own account here
    // would take the instance's administration with it.
    if (req.params.id === currentUser(req).id) {
      return reply.code(403).send({ message: 'You cannot delete your own account through this endpoint' })
    }

    const existing = await db.selectFrom('users').select('id').where('id', '=', req.params.id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ message: 'User not found' })

    // Deleting the only administrator would leave nobody able to administer the
    // instance, which is the same trap as demoting them.
    if (await isLastAdministrator(db, req.params.id)) {
      return reply.code(403).send({ message: 'The last administrator cannot be deleted' })
    }

    await db.deleteFrom('users').where('id', '=', req.params.id).execute()
    opts.events.publish({ name: 'SessionExpired', data: { userId: req.params.id }, userId: req.params.id })
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
        // An admin resetting somebody else's password ends that user's sessions;
        // changing your own does not, which is what the reference does.
        if (adminOnly && userId !== currentUser(req).id) {
          opts.events.publish({ name: 'SessionExpired', data: { userId }, userId })
        }
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
