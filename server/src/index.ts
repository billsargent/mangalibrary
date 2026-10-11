import { buildServer } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/index.js'
import { migrate } from './db/migrate.js'
import { migrations } from './db/migrations/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const database = createDatabase(config.databaseFile)

  const { applied } = await migrate(database.db, migrations)

  const app = await buildServer({ config, database })
  if (applied.length > 0) app.log.info({ applied }, 'applied migrations')

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`)
    app
      .close()
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
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
