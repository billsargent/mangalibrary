import { existsSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** A document that names the files to load: it must be asked for again every time. */
const CACHE_ALWAYS_REVALIDATE = 'no-cache'
/** A file whose name carries the hash of its content can never change. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
/** Everything else in the bundle: the favicons and the like. */
const CACHE_SHORT = 'public, max-age=3600'

/**
 * Paths that belong to the API. Nothing under them is ever answered with the
 * application's page: a client that asks for an endpoint this server does not
 * have must be told so in JSON, not handed a page of HTML with a `200`.
 */
const API_PREFIXES = ['/api', '/sse', '/actuator', '/health', '/opds', '/kobo', '/koreader']

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** The answer Fastify gives for a route it does not have, which is what clients already see. */
function notFound(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 })
}

/** Where `npm run build` in `ui/` leaves the bundle, seen from this file in `src/` or in `dist/`. */
export function bundledUiDir(): string {
  return fileURLToPath(new URL('../../../ui/dist', import.meta.url))
}

/** Whether `dir` holds a built UI. */
export function hasUiBundle(dir: string | null): dir is string {
  return dir !== null && existsSync(join(dir, 'index.html'))
}

/**
 * Serve the built web UI from the same origin as the API.
 *
 * The UI is a single-page application: `/series/0ABC` is a route inside it, not a
 * file. A browser that reloads on such a page asks the server for that path, so
 * every `GET` that is neither a file in the bundle nor an API path is answered with
 * the application's page, and the router inside it takes over.
 *
 * When there is no bundle - a source checkout that has not built one, or a test -
 * nothing is registered and the server answers exactly as it does without a UI.
 */
export async function registerUi(app: FastifyInstance, uiDir: string | null): Promise<boolean> {
  if (!hasUiBundle(uiDir)) return false

  const assets = `${sep}assets${sep}`
  await app.register(fastifyStatic, {
    root: uiDir,
    // The headers below say everything; the plugin's own would contradict them.
    cacheControl: false,
    setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.setHeader('cache-control', CACHE_ALWAYS_REVALIDATE)
      else if (path.includes(assets)) res.setHeader('cache-control', CACHE_IMMUTABLE)
      else res.setHeader('cache-control', CACHE_SHORT)
    },
  })

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? req.url
    const asksForPage = req.method === 'GET' || req.method === 'HEAD'
    // A missing script or image is a missing file. Answering it with the page
    // would hand a browser HTML where it expects JavaScript.
    if (!asksForPage || isApiPath(path) || extname(path) !== '') return notFound(req, reply)
    return reply.sendFile('index.html')
  })

  return true
}
