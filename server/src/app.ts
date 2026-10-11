import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuth } from './auth/session.js'
import type { Config } from './config.js'
import type { Database } from './db/index.js'

export const APP_VERSION = '0.0.0'

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

  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }))

  await registerAuth(app, { db: deps.database.db, sessionTtlMs: deps.config.sessionTtlMs })

  // Closing the server releases the database handle.
  app.addHook('onClose', async () => {
    await deps.database.close()
  })

  return app
}
