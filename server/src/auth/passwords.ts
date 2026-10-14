import bcrypt from 'bcryptjs'

/** Cost factor used for passwords we hash ourselves. */
export const TARGET_ROUNDS = 12

/**
 * The cost fixtures hash at: bcrypt's lowest when the test runner asks for it
 * (`vitest.config.ts`), the real one otherwise.
 */
function fixtureRounds(): number {
  const asked = Number(process.env.MANGALIBRARY_FIXTURE_BCRYPT_ROUNDS)
  return Number.isInteger(asked) && asked >= 4 ? asked : TARGET_ROUNDS
}

/** Hash a password here and now. For tests and fixtures: a request uses {@link hashPasswordAsync}. */
export function hashPassword(password: string, rounds = fixtureRounds()): string {
  return bcrypt.hashSync(password, rounds)
}

/** Check a password here and now. For tests: a request uses {@link verifyPasswordAsync}. */
export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash)
  } catch {
    return false
  }
}

/*
 * A bcrypt hash at cost 12 is about a quarter of a second of arithmetic. Done in one
 * go it stops the server for that long, so a client that sends its password with
 * every page stalls everybody. The asynchronous forms do the same work in small
 * pieces, letting every other request through between them.
 */

/** Hash a password without holding up the server. */
export function hashPasswordAsync(password: string, rounds = TARGET_ROUNDS): Promise<string> {
  return bcrypt.hash(password, rounds)
}

/** Check a password without holding up the server. */
export async function verifyPasswordAsync(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}

/** Cost factor of a bcrypt hash, or `undefined` when it is not a valid hash. */
function costOf(hash: string): number | undefined {
  const match = /^\$2[aby]?\$(\d{2})\$/.exec(hash)
  return match ? Number(match[1]) : undefined
}

/**
 * Whether a stored hash should be re-hashed on the next successful login.
 *
 * Komga hashes with bcrypt at the library default cost (10); imported hashes are
 * upgraded here rather than invalidated. Unrecognised hashes are always flagged.
 */
export function needsRehash(hash: string): boolean {
  const cost = costOf(hash)
  return cost === undefined || cost < TARGET_ROUNDS
}
