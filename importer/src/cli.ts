#!/usr/bin/env node
import { formatReport, importKomga } from './index.js'
import { knownZone, localZone } from './dates.js'
import { groupMappings, parseMapping } from './paths.js'

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function readFlags(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!)
  }
  return values
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function usage(): never {
  console.error(
    [
      'Usage: komga-import --from <komga-dir> --to <dest-dir> [options]',
      '',
      "  --from <dir>       Komga's config folder, the one holding its database.sqlite",
      "  --to <dir>         Manga Library's data folder to create the database in",
      '',
      'Options:',
      '  --map <old>=<new>  A folder Komga knew, and where it is now. Give it more than once',
      '                     for several folders, or for one folder that may be in several',
      '                     places (each library goes to the first that has it).',
      "  --check-files      Look for every book's file where the import puts it, and compare its time",
      '  --timezone <zone>  The time zone Komga ran in, e.g. Europe/Berlin or UTC (most containers).',
      "                     Komga stored its dates in it. Default: this machine's zone.",
      '  --dry-run          Report what would be imported, write nothing',
      '  --rescan-only      Import identity and settings only, then rescan libraries',
      '  --force            Replace what the destination holds (back it up first)',
      '',
      'Example:',
      '  npm run import -- --from ~/.komga --to ~/.mangalibrary --map /srv/manga=/mnt/manga --check-files --dry-run',
    ].join('\n'),
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const from = readFlag(args, '--from')
const to = readFlag(args, '--to')
if (!from || !to) usage()

let map
try {
  map = groupMappings(readFlags(args, '--map').map(parseMapping))
} catch (error) {
  console.error((error as Error).message)
  usage()
}

const timezone = readFlag(args, '--timezone') ?? localZone()
if (!knownZone(timezone)) {
  console.error(`Unknown time zone "${timezone}": give one like Europe/Berlin, America/New_York or UTC.`)
  usage()
}
console.log(`Reading Komga's dates as local times of ${timezone}.`)

const started = performance.now()
importKomga({
  from,
  to,
  dryRun: hasFlag(args, '--dry-run'),
  rescanOnly: hasFlag(args, '--rescan-only'),
  force: hasFlag(args, '--force'),
  checkFiles: hasFlag(args, '--check-files'),
  timezone,
  map,
  progress: (line) => console.log(line),
})
  .then((report) => {
    console.log('')
    console.log(formatReport(report))
    console.log('')
    const took = ((performance.now() - started) / 1000).toFixed(0)
    console.log(`Import ${report.dryRun ? 'preview' : 'completed'} in ${took} s.`)
  })
  .catch((error: unknown) => {
    console.error(`Import failed: ${(error as Error).message}`)
    process.exit(1)
  })
