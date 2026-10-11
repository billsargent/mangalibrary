import { release } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { APP_VERSION } from '../version.js'
import type { RouteOptions } from './libraries.js'

/**
 * Process information for whoever operates the server.
 *
 * The reference implementation answers this from the Spring Boot actuator, so
 * the body is a map whose keys are not part of any client contract: the UI shows
 * it under server settings, and scripts read the version out of it. Ours reports
 * the same shape with the runtime it actually runs on.
 */
export async function registerSystemRoutes(app: FastifyInstance, _opts: RouteOptions): Promise<void> {
  app.get('/actuator/info', async () => ({
    build: {
      artifact: 'mangalibrary',
      group: 'mangalibrary',
      name: 'mangalibrary',
      version: APP_VERSION,
    },
    runtime: {
      name: 'Node.js',
      version: process.version,
    },
    os: {
      name: process.platform,
      arch: process.arch,
      version: release(),
    },
  }))
}
