import type { FastifyInstance } from 'fastify'
import { hashPassword } from '../auth/passwords.js'
import { USER_ROLES } from '../auth/types.js'
import { nextTsid } from '../tsid.js'
import type { UserDto } from './dto.js'
import type { RouteOptions } from './libraries.js'

/** The email shape the reference implementation accepts. */
const EMAIL = /.+@.+\..+/

/**
 * Claiming the server: the one route that creates a user without credentials,
 * because it creates the first one.
 *
 * It is open on purpose, and closed by state rather than by a flag: as soon as
 * any user exists the server counts as claimed, and nothing here can create
 * another one. That is what stops a stranger from walking up to a fresh install
 * and taking it.
 */
export async function registerClaimRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const db = opts.db

  const userCount = async (): Promise<number> => {
    const rows = await db.selectFrom('users').select('id').execute()
    return rows.length
  }

  app.get('/api/v1/claim', async () => ({ isClaimed: (await userCount()) > 0 }))

  app.post('/api/v1/claim', async (req, reply) => {
    const header = (name: string): string => {
      const value = req.headers[name]
      return (Array.isArray(value) ? value[0] : value) ?? ''
    }

    const email = header('x-komga-email').trim()
    const password = header('x-komga-password')

    if (!EMAIL.test(email)) return reply.code(400).send({ message: 'X-Komga-Email must be a valid email address' })
    if (password.trim() === '') return reply.code(400).send({ message: 'X-Komga-Password must not be blank' })

    // Checked before the insert and again by the unique index, so two claims
    // racing each other cannot both win.
    if ((await userCount()) > 0) {
      return reply.code(400).send({ message: 'This server has already been claimed' })
    }

    const now = new Date().toISOString()
    const id = nextTsid()
    try {
      await db
        .insertInto('users')
        .values({
          id,
          email,
          password: hashPassword(password),
          roles: JSON.stringify(USER_ROLES),
          shared_all_libraries: 1,
          age_restriction: null,
          age_restriction_allow_only: null,
          created_date: now,
          last_modified_date: now,
        })
        .execute()
    } catch (err) {
      return reply.code(400).send({ message: (err as Error).message })
    }

    const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    const created: UserDto = {
      id: row.id,
      email: row.email,
      roles: USER_ROLES.slice(),
      sharedAllLibraries: row.shared_all_libraries !== 0,
      sharedLibrariesIds: [],
      labelsAllow: [],
      labelsExclude: [],
    }
    return created
  })
}
