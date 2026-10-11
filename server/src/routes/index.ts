import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { registerBookRoutes } from './books.js'
import { registerCollectionRoutes } from './collections.js'
import { registerLibraryRoutes } from './libraries.js'
import { registerReadListRoutes } from './readlists.js'
import { registerReferentialRoutes } from './referential.js'
import { registerSeriesRoutes } from './series.js'
import { registerUserRoutes } from './users.js'

/** Registers every REST route group implemented so far. */
export async function registerRoutes(app: FastifyInstance, db: Kysely<DB>): Promise<void> {
  const opts = { db }
  await registerLibraryRoutes(app, opts)
  await registerUserRoutes(app, opts)
  await registerReferentialRoutes(app, opts)
  await registerSeriesRoutes(app, opts)
  await registerBookRoutes(app, opts)
  await registerCollectionRoutes(app, opts)
  await registerReadListRoutes(app, opts)
}
