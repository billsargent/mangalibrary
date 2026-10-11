import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { definitions, registerSchemas, routes, specVersion } from './schemas.js'

describe('generated OpenAPI route schemas', () => {
  it('captures the libraries endpoint group', () => {
    expect(specVersion).toBeTypeOf('string')
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(route.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/)
      expect(route.url).toMatch(/^\/api\/v1\/libraries/)
      expect(route.operationId).toBeTruthy()
    }
  })

  it('carries the component definitions', () => {
    expect(Object.keys(definitions).length).toBeGreaterThan(50)
  })

  it('produces schemas Fastify accepts', async () => {
    const app = Fastify({ ajv: { customOptions: { strict: false, validateFormats: false } } })
    registerSchemas(app)
    for (const route of routes) {
      app.route({
        method: route.method as 'GET',
        url: route.url,
        schema: route.schema as Record<string, unknown>,
        handler: async () => ({}),
      })
    }
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })
})
