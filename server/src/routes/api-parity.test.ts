import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildServer } from '../app.js'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { migrations } from '../db/migrations/index.js'

// Every operation of the reference's API, against the routes this server registers.
//
// `ui-contract.test.ts` checks what this project's own web UI calls. That is a subset: the
// reference's API is also what other clients speak - reading apps, scripts, e-readers - and
// an operation none of the UI's pages touches can be missing for a long time before anybody
// finds out. This is the whole list, from the reference's own description of itself.
//
// An operation is "served" when asking for it reaches a route. Whether the route then does
// what the reference does is not something a list can show: `docs/PARITY.md` records that,
// feature by feature.
//
// The comparison is exact in both directions. An operation this server does not serve has
// to be listed below with the reason, and one on the list that starts being served has to
// come off it.

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC_FILE = join(HERE, '..', '..', 'spec', 'komga-openapi.json')

/** Operations of the reference this server does not serve, and why. */
const NOT_SERVED: Record<string, string> = {
  'POST /api/v1/books/import':
    'Importing a file from a folder on the server into a series is not implemented. The Import page reaches this.',
  'GET /api/v1/oauth2/providers': 'There is no OAuth2 or OIDC login.',
  'PUT /api/v1/libraries/{libraryId}': 'Deprecated in the reference in favour of PATCH, which is served.',
  'GET /api/v1/readlists/{id}/read-progress/tachiyomi': 'The Mihon (Tachiyomi) progress endpoints are not implemented.',
  'PUT /api/v1/readlists/{id}/read-progress/tachiyomi': 'The Mihon (Tachiyomi) progress endpoints are not implemented.',
  'GET /api/v2/series/{seriesId}/read-progress/tachiyomi':
    'The Mihon (Tachiyomi) progress endpoints are not implemented.',
  'PUT /api/v2/series/{seriesId}/read-progress/tachiyomi':
    'The Mihon (Tachiyomi) progress endpoints are not implemented.',
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

interface Spec {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], { deprecated?: boolean; tags?: string[] }>>>
}

describe('the operations of the reference API', () => {
  it('are served, or listed as not served', async () => {
    const spec = JSON.parse(readFileSync(SPEC_FILE, 'utf8')) as Spec
    const operations: string[] = []
    for (const [path, entry] of Object.entries(spec.paths)) {
      for (const method of METHODS) if (entry[method]) operations.push(`${method.toUpperCase()} ${path}`)
    }
    expect(operations.length).toBeGreaterThan(150)

    const config = loadConfig({ KOMGA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ml-parity-')), LOG_LEVEL: 'silent' })
    const database = createDatabase(':memory:')
    await migrate(database.db, migrations)
    const app = await buildServer({ config, database })

    const missing: string[] = []
    for (const operation of operations) {
      const [method, path] = operation.split(' ') as [string, string]
      // Any value will do for a parameter: the question is whether a route is reached, and
      // a route that is reached answers something other than "no such route" - most often
      // that the caller is not signed in.
      const url = path.replace(/\{[^}]+\}/g, 'x')
      const response = await app.inject({ method: method as 'GET', url })
      const body = response.body
      if (response.statusCode === 404 && body.includes('Route ') && body.includes(' not found')) missing.push(operation)
    }

    expect(missing.sort()).toEqual(Object.keys(NOT_SERVED).sort())

    await database.close()
    await app.close()
  })
})
