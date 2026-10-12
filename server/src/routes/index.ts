import type { FastifyInstance } from 'fastify'
import { registerBookRoutes } from './books.js'
import { registerClaimRoutes } from './claim.js'
import { registerCollectionRoutes } from './collections.js'
import { registerFontRoutes } from './fonts.js'
import { registerLibraryRoutes, type RouteOptions } from './libraries.js'
import { registerMaintenanceRoutes } from './maintenance.js'
import { registerManifestRoutes } from './manifest.js'
import { registerMediaRoutes } from './media.js'
import { registerReadListRoutes } from './readlists.js'
import { registerReferentialRoutes } from './referential.js'
import { registerRegistrationRoutes } from './registration.js'
import { registerSeriesRoutes } from './series.js'
import { registerSettingsRoutes } from './settings.js'
import { registerSseRoutes } from './sse.js'
import { registerSystemRoutes } from './system.js'
import { registerThumbnailRoutes } from './thumbnails.js'
import { registerTransientBookRoutes } from './transient-books.js'
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
  await registerManifestRoutes(app, opts)
  await registerThumbnailRoutes(app, opts)
  await registerSettingsRoutes(app, opts)
  await registerClaimRoutes(app, opts)
  await registerRegistrationRoutes(app, opts)
  await registerSystemRoutes(app, opts)
  await registerMaintenanceRoutes(app, opts)
  await registerSseRoutes(app, opts)
  await registerFontRoutes(app, opts)
  await registerTransientBookRoutes(app, opts)
}
