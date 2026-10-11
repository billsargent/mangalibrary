// Dev helper: summarise the contract for every path matching a regex.
// Usage: node scripts/show-ops.mjs "series|books"
import { readFileSync } from 'node:fs'

const spec = JSON.parse(readFileSync('server/spec/komga-openapi.json', 'utf8'))
const re = new RegExp(process.argv[2] ?? '.')

const ref = (node) =>
  node === undefined
    ? undefined
    : (node.$ref?.split('/').pop() ??
      node.items?.$ref?.split('/').pop() ??
      (node.type === 'array' ? `array<${ref(node.items)}>` : node.type) ??
      (node.allOf?.length === 1 ? ref(node.allOf[0]) : undefined) ??
      (node.oneOf ? node.oneOf.map(ref).join('|') : undefined))

for (const [p, ops] of Object.entries(spec.paths)) {
  if (!re.test(p)) continue
  for (const [m, op] of Object.entries(ops)) {
    if (m === 'parameters') continue
    const query = (op.parameters ?? []).filter((x) => x.in === 'query').map((x) => x.name)
    const bodyRef = ref(op.requestBody?.content?.['application/json']?.schema)
    const res = op.responses?.['200'] ?? op.responses?.['204']
    const resRef = ref(res?.content?.['application/json']?.schema)
    const parts = [`${m.toUpperCase().padEnd(6)} ${p}`]
    if (bodyRef) parts.push(`  body: ${bodyRef}`)
    if (resRef) parts.push(`  ->200: ${resRef}`)
    if (query.length) parts.push(`  query: ${query.join(', ')}`)
    console.log(parts.join('\n'))
  }
}
