import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { registerAuth } from './auth/session.js'
import type { Config } from './config.js'
import type { Database } from './db/index.js'
import { registerRoutes } from './routes/index.js'
import { MAX_UPLOAD_BYTES } from './uploads.js'
import { APP_VERSION } from './version.js'

export { APP_VERSION }

export interface AppDeps {
  config: Config
  database: Database
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

  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }))

  await registerAuth(app, { db: deps.database.db, sessionTtlMs: deps.config.sessionTtlMs })
  await registerRoutes(app, {
    db: deps.database.db,
    port: deps.config.port,
    configuredPort: deps.config.configuredPort,
  })

  // Closing the server releases the database handle.
  app.addHook('onClose', async () => {
    await deps.database.close()
  })

  return app
}
