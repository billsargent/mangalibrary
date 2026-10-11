#!/usr/bin/env node
import { formatReport, importKomga } from './index.js'

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function usage(): never {
  console.error(
    [
      'Usage: komga-import --from <legacy-dir> --to <dest-dir> [options]',
      '',
      'Options:',
      '  --dry-run        Report what would be imported, write nothing',
      '  --rescan-only    Import identity and settings only, then rescan libraries',
      '  --force          Allow writing into a non-empty destination (back up first)',
      '',
      'Example:',
      '  npm run import -- --from ~/.komga --to ./data',
    ].join('\n'),
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const from = readFlag(args, '--from')
const to = readFlag(args, '--to')
if (!from || !to) usage()

importKomga({
  from,
  to,
  dryRun: hasFlag(args, '--dry-run'),
  rescanOnly: hasFlag(args, '--rescan-only'),
  force: hasFlag(args, '--force'),
})
  .then((report) => {
    console.log(formatReport(report))
    console.log('')
    console.log(`Import ${report.dryRun ? 'preview' : 'completed'} successfully.`)
  })
  .catch((error: unknown) => {
    console.error(`Import failed: ${(error as Error).message}`)
    process.exit(1)
  })
