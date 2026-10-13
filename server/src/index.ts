import { buildServer } from './app.js'
import { homedir } from 'node:os'
import { loadConfig, namesDataDir } from './config.js'
import { adoptLegacyDataDir } from './data-dir.js'
import { createDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import { bundledUiDir, hasUiBundle } from './routes/ui.js'
import { startThreads, stopThreads } from './threads/index.js'
import { startJobWorker } from './worker.js'

async function main(): Promise<void> {
  // An install that began in Komga's directory is brought to ours before anything
  // opens it. A directory named in the environment is the operator's and is left alone.
  const adoption = namesDataDir() ? { outcome: 'NONE' as const } : adoptLegacyDataDir(homedir())
  if (adoption.outcome === 'KEPT') process.env.MANGALIBRARY_CONFIG_DIR = adoption.dir

  const config = loadConfig()
  // The UI built beside the server is served unless another one is named.
  config.uiDir ??= bundledUiDir()
  const database = createDatabase(config.databaseFile)

  const { applied } = await migrate(database.db, migrations)

  const app = await buildServer({ config, database })
  if (applied.length > 0) app.log.info({ applied }, 'applied migrations')
  if (adoption.outcome === 'MOVED') app.log.info(adoption, 'moved the data directory to its new place')
  if (adoption.outcome === 'KEPT')
    app.log.warn(
      adoption,
      'could not move the data directory to ~/.mangalibrary, so the old one is still in use; stop whatever has it open and start again',
    )
  app.log.info(`data directory: ${config.configDir}`)

  // Reading a book's file - unpacking it, rendering it, hashing it - happens on
  // threads of its own, so a scan does not hold up the requests beside it.
  if (config.workerThreads) app.log.info({ threads: startThreads() }, 'reading books on worker threads')
  else app.log.info('reading books on the main thread: worker threads are turned off')

  // The queue is what makes a scan, an analysis and a metadata refresh happen at
  // all: the API only records what was asked for.
  const worker = await startJobWorker({ db: database.db, log: app.log, events: app.events })

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    worker
      .stop()
      .catch((err: unknown) => app.log.error({ err: String(err) }, 'could not stop the job worker'))
      .then(() => stopThreads())
      .catch((err: unknown) => app.log.error({ err: String(err) }, 'could not stop the worker threads'))
      .then(() => app.close())
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const address = await app.listen({ port: config.port, host: config.host })
  app.log.info(`MangaLibrary listening on ${address}`)
  if (hasUiBundle(config.uiDir)) app.log.info(`serving the web UI from ${config.uiDir}`)
  else
    app.log.warn(`no web UI at ${config.uiDir}: build it with "npm run build:ui", or point MANGALIBRARY_UI_DIR at one`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
