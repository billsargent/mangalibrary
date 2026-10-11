// Dev helper: print the raw JSON of a query parameter.
// Usage: node scripts/show-param.mjs "GET /api/v1/series" sort
import { readFileSync } from 'node:fs'

const spec = JSON.parse(readFileSync('server/spec/komga-openapi.json', 'utf8'))
const [method, path] = process.argv[2].split(' ')
const name = process.argv[3]
const op = spec.paths[path][method.toLowerCase()]
for (const p of op.parameters ?? []) {
  if (p.name === name) console.log(JSON.stringify(p, null, 2))
}
