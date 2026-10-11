import bcrypt from 'bcryptjs'

/** Cost factor used for passwords we hash ourselves. */
export const TARGET_ROUNDS = 12

export function hashPassword(password: string, rounds = TARGET_ROUNDS): string {
  return bcrypt.hashSync(password, rounds)
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash)
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
