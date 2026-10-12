import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../app.js'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

// The endpoints the forked UI calls, against the routes this server registers.
//
// The UI is upstream's next-ui and its client is generated from the reference's OpenAPI
// document, so it asks for endpoints this server has to answer. A path it calls that is not
// registered here is a page that cannot work, and the failure is a 404 in a browser console
// - or, worse, a 404 nobody looks at, because the UI treats a failed panel as an empty one.
// Comparing the two lists is the only place that difference shows up before a person clicks
// something.
//
// What the generated client can call is not what the UI does call: the file holds the
// reference's whole API, including endpoints no page touches. Only the generated functions
// the UI's own code references are compared, so a function nobody calls need not exist.
//
// The comparison is exact in both directions, on purpose: a path the UI calls and this
// server does not serve has to be listed below with a reason, and a path on that list this
// server starts answering has to come off it.

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_SRC = join(HERE, '..', '..', '..', 'ui', 'src')
const SDK_FILE = join(UI_SRC, 'generated', 'openapi', 'sdk.gen.ts')

// Endpoints the UI calls that this server does not answer, and why. Anything the UI calls
// that is not on this list has to be served.
//
// A few URLs are built by hand instead of through the client - `ui/src/api/images.ts`,
// `files.ts`, `links.ts`, `composables/sse.ts` - and this test cannot see them, because
// what they build is a template string, not a generated function. Two of those are known to
// be missing: `GET /api/v1/books/{bookId}/pages/{n}/raw` (a single page of a PDF needs a
// renderer this server does not have, #23) and `GET /api/v1/books/{bookId}/resource/{r}`
// (the inside of an EPUB, for the EPUB reader, #98).
const NOT_SERVED: Record<string, string> = {
  'POST /api/v1/books/import':
    'Importing books from a path on the server is the import page`s flow, and it is not implemented; the transient-books upload path is what this server offers instead (#23).',
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const METHOD_MARK = 'client).'
const URL_MARK = "url: '"

/**
 * Read the generated client into `functionName -> 'GET /api/...'`.
 *
 * Each function is one call: the line that starts it names the function and the method it
 * calls, and the url is a string on a line of its own a few lines later. Path parameters
 * come out as `{name}` and Fastify spells the same thing `:name`.
 */
function generatedCalls(source: string): Map<string, string> {
  const calls = new Map<string, string>()
  let pending: string[] | undefined

  for (const line of source.split('\n')) {
    if (line.startsWith('export const komga')) {
      const name = line.slice('export const '.length).split(' ')[0]
      const method = METHODS.find((candidate) => line.includes(METHOD_MARK + candidate))
      pending = name && method ? [name, method.toUpperCase()] : undefined
      continue
    }

    const at = line.indexOf(URL_MARK)
    if (!pending || at === -1) continue

    const path = line.slice(at + URL_MARK.length, line.lastIndexOf("'"))
    const name = pending[0]
    const method = pending[1]
    pending = undefined
    if (!name || !method || !path.startsWith('/')) continue

    calls.set(name, `${method} ${path.replace(/\{([^}]+)\}/g, ':$1')}`)
  }

  return calls
}

/** The generated functions the UI's own code references. */
function usedFunctions(): Set<string> {
  const used = new Set<string>()
  const entries = readdirSync(UI_SRC, { recursive: true, withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.vue')) continue
    const file = join(entry.parentPath, entry.name)
    if (file.includes(join('src', 'generated'))) continue

    for (const match of readFileSync(file, 'utf8').matchAll(/\bkomga[A-Z]\w*(?=\s*\()/g)) {
      used.add(match[0])
    }
  }

  return used
}

describe('the endpoints the forked UI calls', () => {
  it.skipIf(!existsSync(SDK_FILE))('are served, or listed as not served', async () => {
    const calls = generatedCalls(readFileSync(SDK_FILE, 'utf8'))

    const paths = new Map<string, string>()
    for (const name of usedFunctions()) {
      const call = calls.get(name)
      if (call && !paths.has(call)) paths.set(call, name)
    }
    // A name can be referenced without matching a generated function, but the bulk of them
    // have to resolve or this test is checking nothing.
    expect(paths.size).toBeGreaterThan(50)

    const config = loadConfig({ KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-ui-')), LOG_LEVEL: 'silent' })
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const app = await buildServer({ config, database })

    const missing = []
    for (const call of paths.keys()) {
      const [method, url] = call.split(' ')
      if (method && url && !app.hasRoute({ method: method as 'GET', url })) missing.push(call)
    }

    expect(missing.sort()).toEqual(Object.keys(NOT_SERVED).sort())

    await database.close()
    await app.close()
  })
})

/**
 * The operators in the UI's search conditions, against the ones the contract defines.
 *
 * A condition is a small tree of `{ field: { operator, value } }`, and an operator the
 * server does not know is a `400` for the whole request - so one wrong spelling in one
 * component empties a page. The UI is written against generated types that spell them the
 * contract's way (`is`, `isNot`, `isFalse`), but a literal inside an object that is later
 * cast to a condition type is never checked against it: this test found `oneshot` for
 * `oneShot` and `Is`/`IsNot`/`IsFalse` for `is`/`isNot`/`isFalse`, each of which was a page
 * answering `400`.
 */
describe('the search operators the forked UI sends', () => {
  const specFile = join(HERE, '..', '..', 'spec', 'komga-openapi.json')

  it.skipIf(!existsSync(UI_SRC))('are ones the contract defines', () => {
    const schemas = (JSON.parse(readFileSync(specFile, 'utf8')) as { components: { schemas: Record<string, unknown> } })
      .components.schemas

    const known = new Set<string>()
    for (const [name, schema] of Object.entries(schemas)) {
      if (!name.includes('Operator')) continue
      const typed = schema as { discriminator?: { mapping?: Record<string, string> } }
      for (const operator of Object.keys(typed.discriminator?.mapping ?? {})) known.add(operator)
    }
    expect(known.has('is')).toBe(true)

    const sent = new Set<string>()
    const entries = readdirSync(UI_SRC, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|vue)$/.test(entry.name)) continue
      const file = join(entry.parentPath, entry.name)
      if (file.includes(join('src', 'generated'))) continue
      for (const match of readFileSync(file, 'utf8').matchAll(/operator:\s*'(\w+)'/g)) {
        if (match[1]) sent.add(match[1])
      }
    }

    expect([...sent].filter((operator) => !known.has(operator)).sort()).toEqual([])
  })
})
