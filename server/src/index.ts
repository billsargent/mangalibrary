import { buildServer } from './app.js'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { ConfigError, ensureWritable, loadConfig, namesDataDir, programConfigFile } from './config.js'
import { adoptLegacyDataDir } from './data-dir.js'
import { createDatabase, refreshStatistics } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'
import { bundledUiDir, hasUiBundle } from './routes/ui.js'
import { startThreads, stopThreads } from './threads/index.js'
import { startJobWorker } from './worker.js'

async function main(): Promise<void> {
  // An install that began in Komga's directory is brought to ours before anything
  // opens it. A directory named in the environment is the operator's and is left alone.
  const programFile = programConfigFile()
  const adoption = namesDataDir(process.env, programFile) ? { outcome: 'NONE' as const } : adoptLegacyDataDir(homedir())
  if (adoption.outcome === 'KEPT') process.env.MANGALIBRARY_CONFIG_DIR = adoption.dir

  const config = loadConfig(process.env, programFile)
  ensureWritable(config)
  // The UI built beside the server is served unless another one is named.
  config.uiDir ??= bundledUiDir()
  const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`
  const startedAt = performance.now()
  const took: string[] = []
  let mark = startedAt
  const timed = (what: string) => {
    const now = performance.now()
    took.push(`${what} ${seconds(now - mark)}`)
    mark = now
  }

  const database = createDatabase(config.databaseFile)
  timed('database')

  // An update can bring steps that rebuild indexes over every book, which on a large
  // library takes minutes. The logger does not exist yet, and someone is watching a
  // terminal that has gone quiet, so this is said in plain words as it happens.
  //
  // Building an index sorts the whole table, and SQLite sorts within its page cache,
  // which is 2 MB unless told otherwise; beyond that it sorts through files on disk.
  // On a hard disk that is the difference between minutes and half an hour, so the
  // upgrade is given more. It is only taken as it is needed, and given back after.
  database.sqlite.pragma(`cache_size = -${UPGRADE_CACHE_MB * 1024}`)
  const { applied } = await migrate(database.db, migrations, {
    onPending: (ids) =>
      console.log(
        `Upgrading the database: ${ids.length} step${ids.length === 1 ? '' : 's'}. On a large library this can take some minutes; please do not stop it.`,
      ),
    onStep: (id, milliseconds) => console.log(`  done: ${id} (${seconds(milliseconds)})`),
  })
  if (applied.length > 0) {
    // What an upgrade writes goes first to the side file (`-wal`), and is moved into
    // the database later - at the latest when the server stops, which then takes as
    // long as the upgrade's writing did. It is done now instead, where it is expected.
    const folding = performance.now()
    console.log(`  moving the upgrade into the database file (${megabytes(walBytes(config.databaseFile))})...`)
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)')
    console.log(`  done: moving the upgrade into the database file (${seconds(performance.now() - folding)})`)
  }
  database.sqlite.pragma('cache_size = -2000')
  timed(applied.length > 0 ? 'upgrade' : 'checking for upgrades')

  const analysing = performance.now()
  await refreshStatistics(database.db)
  if (applied.length > 0) {
    console.log(`  done: updating the database's statistics (${seconds(performance.now() - analysing)})`)
    console.log('The database is up to date; starting.')
  }
  timed('statistics')

  const app = await buildServer({ config, database })
  if (applied.length > 0) app.log.info({ applied }, 'applied migrations')
  if (adoption.outcome === 'MOVED') app.log.info(adoption, 'moved the data directory to its new place')
  if (adoption.outcome === 'KEPT')
    app.log.warn(
      adoption,
      'could not move the data directory to ~/.mangalibrary, so the old one is still in use; stop whatever has it open and start again',
    )
  app.log.info(`data directory: ${config.configDir}`)
  app.log.info(`database: ${config.databaseFile}`)
  if (config.configFile !== null) app.log.info(`config file: ${config.configFile}`)

  // Reading a book's file - unpacking it, rendering it, hashing it - happens on
  // threads of its own, so a scan does not hold up the requests beside it.
  if (config.workerThreads) app.log.info({ threads: startThreads() }, 'reading books on worker threads')
  else app.log.info('reading books on the main thread: worker threads are turned off')

  // The queue is what makes a scan, an analysis and a metadata refresh happen at
  // all: the API only records what was asked for.
  const worker = await startJobWorker({ db: database.db, log: app.log, events: app.events })

  // Stopping waits on several things in turn, and each is said with how long it
  // took, so that a slow stop says why. A Ctrl+C in the start script reaches this
  // process twice - from the terminal and from the script - and is acted on once.
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`\nStopping (${signal}).`)
    const stage = async (what: string, work: () => Promise<unknown>) => {
      const began = performance.now()
      try {
        await work()
      } catch (err) {
        app.log.error({ err: String(err) }, `could not stop cleanly: ${what}`)
      }
      console.log(`  done: ${what} (${seconds(performance.now() - began)})`)
    }
    await stage('the jobs that were running', () => worker.stop())
    await stage('the threads that read books', () => stopThreads())
    await stage(`connections, and closing the database (side file ${megabytes(walBytes(config.databaseFile))})`, () =>
      app.close(),
    )
    console.log('Stopped.')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  const address = await app.listen({ port: config.port, host: config.host })
  timed('starting the server')
  app.log.info(`MangaLibrary listening on ${address}`)
  console.log(`Ready in ${seconds(performance.now() - startedAt)} (${took.join(', ')}).`)
  if (hasUiBundle(config.uiDir)) app.log.info(`serving the web UI from ${config.uiDir}`)
  else
    app.log.warn(`no web UI at ${config.uiDir}: build it with "npm run build:ui", or point MANGALIBRARY_UI_DIR at one`)
}

/** How much page cache an upgrade may use, in megabytes. */
const UPGRADE_CACHE_MB = 256

/** The size of the database's side file, which holds what is not yet in the database file itself. */
function walBytes(databaseFile: string): number {
  try {
    return statSync(`${databaseFile}-wal`).size
  } catch {
    return 0
  }
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

main().catch((err) => {
  // A mistake in the configuration is said plainly; anything else is a fault of
  // ours, and is shown with where it came from.
  if (err instanceof ConfigError) console.error(`\nManga Library cannot start: ${err.message}\n`)
  else console.error(err)
  process.exit(1)
})
