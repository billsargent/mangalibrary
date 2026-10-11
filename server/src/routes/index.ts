import type { FastifyInstance } from 'fastify'
import { registerBookRoutes } from './books.js'
import { registerClaimRoutes } from './claim.js'
import { registerCollectionRoutes } from './collections.js'
import { registerLibraryRoutes, type RouteOptions } from './libraries.js'
import { registerMaintenanceRoutes } from './maintenance.js'
import { registerMediaRoutes } from './media.js'
import { registerReadListRoutes } from './readlists.js'
import { registerReferentialRoutes } from './referential.js'
import { registerSeriesRoutes } from './series.js'
import { registerSettingsRoutes } from './settings.js'
import { registerSystemRoutes } from './system.js'
import { registerThumbnailRoutes } from './thumbnails.js'
import { registerUserRoutes } from './users.js'

/** Registers every REST route group implemented so far. */
export async function registerRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  await registerLibraryRoutes(app, opts)
  await registerUserRoutes(app, opts)
  await registerReferentialRoutes(app, opts)
  await registerSeriesRoutes(app, opts)
  await registerBookRoutes(app, opts)
  await registerCollectionRoutes(app, opts)
  await registerReadListRoutes(app, opts)
  await registerMediaRoutes(app, opts)
  await registerThumbnailRoutes(app, opts)
  await registerSettingsRoutes(app, opts)
  await registerClaimRoutes(app, opts)
  await registerSystemRoutes(app, opts)
  await registerMaintenanceRoutes(app, opts)
}
