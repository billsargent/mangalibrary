import type { FastifyInstance } from 'fastify'
import { hashPasswordAsync } from '../auth/passwords.js'
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

  // Claims are taken one at a time. Checking that nobody has claimed the server and
  // making the account are separate steps, with the password hashed in between, and
  // two claims arriving together would otherwise both find the server unclaimed.
  let claiming: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = claiming.then(work, work)
    claiming = turn.catch(() => undefined)
    return turn
  }

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

    const claimedAlready = () => reply.code(400).send({ message: 'This server has already been claimed' })
    // Asked first so a claimed server costs nobody a password hash, and asked again
    // in turn, so that of two claims arriving together only one makes an account.
    if ((await userCount()) > 0) return claimedAlready()
    const hashed = await hashPasswordAsync(password)

    const now = new Date().toISOString()
    const id = nextTsid()
    let made: boolean
    try {
      made = await oneAtATime(async () => {
        if ((await userCount()) > 0) return false
        await db
          .insertInto('users')
          .values({
            id,
            email,
            password: hashed,
            roles: JSON.stringify(USER_ROLES),
            shared_all_libraries: 1,
            age_restriction: null,
            age_restriction_allow_only: null,
            created_date: now,
            last_modified_date: now,
          })
          .execute()
        return true
      })
    } catch (err) {
      return reply.code(400).send({ message: (err as Error).message })
    }
    if (!made) return claimedAlready()

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
