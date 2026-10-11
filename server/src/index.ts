import Fastify from 'fastify'

/**
 * MangaLibrary server entrypoint.
 *
 * At this stage this is only a health stub used to validate the skeleton; the
 * real API, config, database and auth layers are added under their own issues.
 */
export function buildServer() {
  const app = Fastify({ logger: true })

  app.get('/health', async () => ({ status: 'ok', version: '0.0.0' }))

  return app
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))

if (isMain) {
  const app = buildServer()
  const port = Number.parseInt(process.env.SERVER_PORT ?? process.env.PORT ?? '25600', 10)
  app
    .listen({ port, host: '0.0.0.0' })
    .then((address) => app.log.info(`MangaLibrary listening on ${address}`))
    .catch((err) => {
      app.log.error(err)
      process.exit(1)
    })
}
