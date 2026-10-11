// Dev helper: list spec paths matching a regex, with their required query params.
// Usage: node scripts/list-paths.mjs <regex> [specPath]
import { readFileSync } from 'node:fs'

const pattern = process.argv[2] ?? '.'
const specPath = process.argv[3] ?? 'server/spec/komga-openapi.json'
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const re = new RegExp(pattern)
const rows = []

for (const [p, ops] of Object.entries(spec.paths)) {
  if (!re.test(p)) continue
  for (const [m, op] of Object.entries(ops)) {
    if (m === 'parameters') continue
    const query = (op.parameters ?? []).filter((x) => x.in === 'query')
    const required = query.filter((x) => x.required).map((x) => x.name)
    rows.push(`${m.toUpperCase().padEnd(7)}${p}${required.length ? `  REQUIRED=${required.join(',')}` : ''}`)
  }
}

console.log(rows.join('\n'))
console.log(`TOTAL ${rows.length}`)
