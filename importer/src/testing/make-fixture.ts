/**
 * Writes a legacy Komga database fixture to `<dir>/database.sqlite`.
 *
 * Useful for exercising the CLI end to end:
 *   npm run fixture -- /tmp/legacy
 *   npm run import -- --from /tmp/legacy --to /tmp/target
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLegacyFixture } from './legacy-fixture.js'

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: tsx src/testing/make-fixture.ts <dir>')
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
const file = join(dir, 'database.sqlite')
createLegacyFixture(file)
console.log(`Legacy fixture written to ${file}`)
