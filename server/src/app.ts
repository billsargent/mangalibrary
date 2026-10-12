import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { registerAuth, AUTH_TOKEN_HEADER } from './auth/session.js'
import type { Config } from './config.js'
import type { Database } from './db/index.js'
import { EventBus } from './events.js'
import { fetchJson as defaultFetchJson, type FetchJson } from './http.js'
import { registerRoutes } from './routes/index.js'
import { registerUi } from './routes/ui.js'
import { MAX_UPLOAD_BYTES } from './uploads.js'
import { APP_VERSION } from './version.js'

export { APP_VERSION }

export interface AppDeps {
  config: Config
  database: Database
  /** Overridden in tests: nothing here should reach the network. */
  fetchJson?: FetchJson
}

/**
 * Build the Fastify instance. Kept separate from the entrypoint so tests can
 * exercise it with `inject` without binding a port.
 */
export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    trustProxy: true,
  })

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } })

  // Registration order matters: the preflight is answered by a hook this plugin
  // adds, and it has to run before the auth hook rejects an unauthenticated
  // `OPTIONS` - a preflight never carries the credentials it is asking about.
  if (deps.config.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: deps.config.corsAllowedOrigins,
      credentials: true,
      // The reference allows every method and exposes the two headers a browser
      // client has to read: the download name, and the session token.
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['Content-Disposition', AUTH_TOKEN_HEADER],
    })
  }

  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }))

  await registerAuth(app, { db: deps.database.db, sessionTtlMs: deps.config.sessionTtlMs })

  // One bus for the whole server: the routes and the worker both announce changes
  // on it, and the SSE connections are what listen.
  const events = new EventBus()
  app.decorate('events', events)

  await registerRoutes(app, {
    db: deps.database.db,
    events,
    fetchJson: deps.fetchJson ?? defaultFetchJson,
    announcementsUrl: deps.config.announcementsUrl,
    releasesUrl: deps.config.releasesUrl,
    fontsDir: deps.config.fontsDir,
    port: deps.config.port,
    configuredPort: deps.config.configuredPort,
  })

  // Last, so that every API route is already there to take precedence over it.
  await registerUi(app, deps.config.uiDir)

  // Closing the server releases the database handle.
  app.addHook('onClose', async () => {
    await deps.database.close()
  })

  return app
}
