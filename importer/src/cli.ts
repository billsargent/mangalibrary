#!/usr/bin/env node
import { importKomga } from './index.js'

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  return args[i + 1]
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
      '  --rescan-only    Import users/settings/collections/read lists, then rescan libraries',
      '  --force          Allow writing into a non-empty destination (back up first)',
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
