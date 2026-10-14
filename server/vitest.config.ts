import { defineConfig } from 'vitest/config'

/**
 * Tests run many files at once, and each builds servers and hashes passwords. Two
 * things keep a busy machine from failing them on time alone:
 *
 * - Passwords made for fixtures are hashed at bcrypt's lowest cost
 *   (`hashPassword` reads this; the server's own hashing does not), a few
 *   milliseconds instead of a quarter of a second each.
 * - A test may take fifteen seconds: those that read books on worker threads or
 *   check passwords for real take a few, and contend for the machine with every
 *   other file.
 */
export default defineConfig({
  test: {
    env: { MANGALIBRARY_FIXTURE_BCRYPT_ROUNDS: '4' },
    testTimeout: 15_000,
  },
})
