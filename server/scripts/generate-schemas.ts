/**
 * Generates Fastify route schemas from the vendored Komga OpenAPI spec.
 *
 * Usage: npm run generate:schemas
 *
 * Currently scoped to one endpoint group (see GROUPS) to prove the pipeline;
 * more groups are added as their controllers are implemented.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const specPath = join(root, 'spec', 'komga-openapi.json')
const outPath = join(root, 'src', 'generated', 'schemas.ts')

const GROUPS = ['/api/v1/libraries']
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const REF_PREFIX = 'komga#/definitions/'

type Json = any

const spec: Json = JSON.parse(readFileSync(specPath, 'utf8'))

function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node && typeof node === 'object') {
    const out: Json = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
        out[key] = REF_PREFIX + value.slice('#/components/schemas/'.length)
      } else {
        out[key] = rewriteRefs(value)
      }
    }
    return out
  }
  return node
}

function parametersSchema(parameters: Json[] | undefined, location: string): Json | undefined {
  const list = (parameters ?? []).filter((p) => p.in === location)
  if (list.length === 0) return undefined
  const properties: Json = {}
  const required: string[] = []
  for (const p of list) {
    properties[p.name] = rewriteRefs(p.schema ?? { type: 'string' })
    if (p.required) required.push(p.name)
  }
  const schema: Json = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

function responseSchema(op: Json): Json | undefined {
  const out: Json = {}
  for (const [code, res] of Object.entries(op.responses ?? {})) {
    const schema = (res as Json)?.content?.['application/json']?.schema
    if (schema) out[code] = rewriteRefs(schema)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const definitions = rewriteRefs(spec.components?.schemas ?? {})

const routes: Json[] = []
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  if (!GROUPS.some((group) => path.startsWith(group))) continue
  for (const method of METHODS) {
    const op = (item as Json)[method]
    if (!op) continue

    const schema: Json = {}
    const params = parametersSchema(op.parameters, 'path')
    const querystring = parametersSchema(op.parameters, 'query')
    const body = op.requestBody?.content?.['application/json']?.schema
    const response = responseSchema(op)

    if (params) schema.params = params
    if (querystring) schema.querystring = querystring
    if (body) schema.body = rewriteRefs(body)
    if (response) schema.response = response

    routes.push({
      method: method.toUpperCase(),
      url: path.replace(/\{([^}]+)\}/g, ':$1'),
      operationId: op.operationId ?? `${method}:${path}`,
      schema,
    })
  }
}

const specVersion: string = spec.info?.version ?? 'unknown'

const file = `// AUTO-GENERATED - do not edit by hand.
// Source: spec/komga-openapi.json (Komga API v${specVersion}).
// Regenerate with: npm run generate:schemas

import type { FastifyInstance } from 'fastify'

export interface GeneratedRoute {
  method: string
  url: string
  operationId: string
  schema: Record<string, unknown>
}

export const specVersion = ${JSON.stringify(specVersion)}

/** Component schemas from the OpenAPI spec, with refs rewritten for Ajv. */
export const definitions: Record<string, unknown> = ${JSON.stringify(definitions, null, 2)}

export const routes: GeneratedRoute[] = ${JSON.stringify(routes, null, 2)}

/** Register the shared component schemas so \`$ref: "${REF_PREFIX}..."\` resolves. */
export function registerSchemas(app: FastifyInstance): void {
  app.addSchema({ $id: 'komga', definitions } as never)
}
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, file, 'utf8')
console.log(`Generated ${routes.length} route schema(s) -> ${outPath}`)
