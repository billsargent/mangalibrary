#!/usr/bin/env node
/**
 * Start Manga Library, built.
 *
 *   node scripts/start.mjs            build what is missing or out of date, then start
 *   node scripts/start.mjs --no-build start what is built, as it is
 *
 * `npm run dev` is the other way to start it: from source, restarting whenever a
 * file changes, which is for working on it. This is for running it.
 *
 * Settings come from the environment, as `docs/CONFIGURATION.md` describes:
 * `SERVER_PORT`, `SERVER_HOST`, `MANGALIBRARY_CONFIG_DIR`, `LOG_LEVEL`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const server = join(root, 'server')
const ui = join(root, 'ui')
const builtServer = join(server, 'dist', 'index.js')
const builtUi = join(ui, 'dist', 'index.html')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const stop = (message) => {
  console.error(`\nManga Library cannot start: ${message}\n`)
  process.exit(1)
}

// The database module is compiled code, and ships ready-made for some versions of
// Node and not others. Asking it to open a database is the one check that is right
// whatever the version: a number compared here would go stale.
const major = Number(process.versions.node.split('.')[0])
if (major < 22) stop(`it needs Node.js 22, and this is Node.js ${process.versions.node}.`)
if (!existsSync(join(server, 'node_modules'))) {
  stop('its dependencies are not installed. Run "npm run install:all" in this folder first.')
}
try {
  const Database = createRequire(join(server, 'package.json'))('better-sqlite3')
  new Database(':memory:').close()
} catch (error) {
  stop(
    `the database module does not load under Node.js ${process.versions.node}.\n` +
      'It ships ready-made for Node.js 22: install that version, then run "npm run install:all" again.\n' +
      `(${String(error.message ?? error).split('\n')[0]})`,
  )
}

/** When the newest file under a folder was changed, leaving out what a build does not read. */
function newest(folder) {
  let latest = 0
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const path = join(folder, entry.name)
    const time = entry.isDirectory() ? newest(path) : statSync(path).mtimeMs
    if (time > latest) latest = time
  }
  return latest
}
const stale = (built, sources) =>
  !existsSync(built) || sources.some((source) => newest(source) > statSync(built).mtimeMs)

function build(what, script) {
  console.log(`Building ${what}...`)
  const result = spawnSync(npm, ['run', script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) stop(`building ${what} failed; what went wrong is above.`)
}

if (!process.argv.includes('--no-build')) {
  if (stale(builtServer, [join(server, 'src')])) build('the server', 'build:server')
  if (stale(builtUi, [join(ui, 'src'), join(ui, 'i18n')])) {
    if (existsSync(join(ui, 'node_modules'))) build('the web UI', 'build:ui')
    else if (existsSync(builtUi))
      console.log('The web UI is older than its source and its dependencies are not installed; using it as it is.')
    else stop('the web UI is not built and its dependencies are not installed. Run "npm run install:all" first.')
  }
}
if (!existsSync(builtServer)) stop('the server is not built. Run "npm run build" first.')

// Where it will answer and where it keeps things, said in plain words before the
// server's own log begins. Asked of the server's own configuration, so that what is
// printed here is what the server will do.
const { pathToFileURL } = await import('node:url')
const { ConfigError, loadConfig, programConfigFile } = await import(
  pathToFileURL(join(server, 'dist', 'config.js')).href
)
let config
try {
  config = loadConfig(process.env, programConfigFile())
} catch (error) {
  if (error instanceof ConfigError) stop(error.message)
  throw error
}
const { port, host } = config
const addresses =
  host === '0.0.0.0'
    ? Object.values(networkInterfaces())
        .flat()
        .filter((address) => address && address.family === 'IPv4' && !address.internal)
        .map((address) => address.address)
    : [host]
console.log('\nManga Library is starting.')
console.log(`  Data folder:  ${config.configDir}`)
console.log(`  Database:     ${config.databaseFile}`)
console.log(
  config.configFile === null
    ? '  Config file:  none (copy mangalibrary.example.json to mangalibrary.json to have one)'
    : `  Config file:  ${config.configFile}`,
)
console.log('It will be at:')
console.log(`  http://localhost:${port}   (this machine)`)
for (const address of addresses) console.log(`  http://${address}:${port}   (other machines on the network)`)
console.log('The first start after an update can take some minutes while the database is upgraded;')
console.log('it says what it is doing, and when it is listening it is ready.')
console.log('Press Ctrl+C to stop.\n')

const child = spawn(process.execPath, [builtServer], { cwd: root, stdio: 'inherit' })
// The server finishes what it is doing when asked to stop; this waits for it.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)))
