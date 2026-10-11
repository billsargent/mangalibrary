// Dev helper: print property names/types of a spec schema, or the query params of a path.
// Usage: node scripts/show-schema.mjs <SchemaName>
//        node scripts/show-schema.mjs --params "GET /api/v1/series"
//        node scripts/show-schema.mjs --params "GET /api/v1/books"
import { readFileSync } from 'node:fs'

const spec = JSON.parse(readFileSync('server/spec/komga-openapi.json', 'utf8'))
const arg = process.argv.slice(2)

if (arg[0] === '--params') {
  const [method, path] = arg[1].split(' ')
  const ops = spec.paths[path]
  if (!ops) throw new Error(`no path ${path}`)
  const op = ops[method.toLowerCase()]
  const rows = []
  for (const p of op.parameters ?? []) {
    if (p.in !== 'query') continue
    const type = p.schema?.type ?? p.schema?.$ref ?? p.schema?.items?.$ref ?? 'ref'
    rows.push(`${p.required ? '*' : ' '} ${p.name.padEnd(28)} ${type}`)
  }
  console.log(rows.join('\n'))
  console.log(`TOTAL ${rows.length}`)
} else {
  const name = arg[0]
  const schema = spec.components.schemas[name]
  if (!schema) throw new Error(`no schema ${name}; have ${Object.keys(spec.components.schemas).length}`)
  const required = new Set(schema.required ?? [])
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const type =
      v.$ref ??
      v.type ??
      (v.oneOf ? `oneOf(${v.oneOf.map((o) => o.$ref ?? o.type).join('|')})` : null) ??
      (v.allOf ? 'allOf' : 'unknown')
    const extra = v.items ? `[]<${v.items.$ref ?? v.items.type}>` : ''
    console.log(`${required.has(k) ? '*' : ' '} ${k.padEnd(26)} ${type}${extra}${v.nullable ? ' |null' : ''}`)
  }
}
