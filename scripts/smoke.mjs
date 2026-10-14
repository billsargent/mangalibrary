#!/usr/bin/env node
/**
 * Does what somebody installing Manga Library does, and fails if any of it fails.
 *
 * Starts the built server on an empty data folder, creates the administrator, adds
 * a library of generated books, waits for the scan and the analysis, then asks for
 * a series list, a page, a poster and the web UI, and saves a reading position -
 * through the machine's network address when it has one, because that is how the
 * server is reached from another machine.
 *
 * Run it after `npm run build`: `npm run smoke`. CI runs it on Linux.
 *
 * With `SMOKE_DOCKER_IMAGE` set to an image, it runs that image instead, with the
 * library mounted at /books and the data folder at /data, and asks the same things
 * of it: `docker build -t mangalibrary . && SMOKE_DOCKER_IMAGE=mangalibrary npm run smoke`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sharp = createRequire(join(root, 'server', 'package.json'))('sharp')

const PORT = process.env.SMOKE_PORT ?? '25699'
const DOCKER_IMAGE = process.env.SMOKE_DOCKER_IMAGE
const EMAIL = 'admin@example.com'
const PASSWORD = 'correct-horse-battery'
const lan = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === 'IPv4' && !address.internal)?.address
// A container's port is published on this machine, which is where it is asked.
const base = DOCKER_IMAGE ? `http://127.0.0.1:${PORT}` : `http://${lan ?? '127.0.0.1'}:${PORT}`

/** A zip of files stored as they are, which is all a CBZ has to be. */
function zip(entries) {
  const parts = []
  const directory = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directoryBytes = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directoryBytes, end])
}

const work = mkdtempSync(join(tmpdir(), 'mangalibrary-smoke-'))
const library = join(work, 'library')
const pages = []
for (const colour of ['#27466b', '#5b2333', '#2f5d50']) {
  pages.push(
    await sharp({ create: { width: 400, height: 600, channels: 3, background: colour } })
      .jpeg()
      .toBuffer(),
  )
}
for (const [series, book, number] of [
  ['Akira', 'Volume 1', '1'],
  ['Akira', 'Volume 2', '2.5'],
  ['Berserk', 'Chapter 1', '1'],
]) {
  mkdirSync(join(library, series), { recursive: true })
  writeFileSync(
    join(library, series, `${book}.cbz`),
    zip([
      ...pages.map((data, index) => ({ name: `page-${index + 1}.jpg`, data })),
      {
        name: 'ComicInfo.xml',
        data: Buffer.from(`<ComicInfo><Series>${series}</Series><Number>${number}</Number></ComicInfo>`),
      },
    ]),
  )
}

// Everything it is told, it is told by a config file: where the data goes, where
// the database goes - somewhere else, and by a path relative to the file - and the port.
const configFile = join(work, 'settings', 'mangalibrary.json')
const databaseFile = join(work, 'database', 'library.sqlite')
mkdirSync(join(work, 'settings'))
writeFileSync(
  configFile,
  JSON.stringify({
    dataDir: '../data',
    databaseFile: '../database/library.sqlite',
    port: Number(PORT),
    logLevel: 'warn',
  }),
)

// Started the way the README says to: through start.sh where there is a shell for it -
// or as the image is run, with the library and the data folder mounted.
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
const user = process.getuid ? [`--user`, `${process.getuid()}:${process.getgid()}`] : []
const [command, ...args] = DOCKER_IMAGE
  ? [
      'docker',
      'run',
      '--rm',
      '--name',
      'mangalibrary-smoke',
      ...user,
      '-p',
      `${PORT}:25600`,
      '-e',
      'LOG_LEVEL=warn',
      '-v',
      `${library}:/books:ro`,
      '-v',
      `${dataDir}:/data`,
      DOCKER_IMAGE,
    ]
  : process.platform === 'win32'
    ? [process.execPath, join(root, 'scripts', 'start.mjs'), '--no-build']
    : ['sh', join(root, 'scripts', 'start.sh'), '--no-build']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, MANGALIBRARY_CONFIG_FILE: configFile },
  stdio: ['ignore', 'inherit', 'inherit'],
})
let exited = null
server.on('exit', (code) => (exited = code ?? 0))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const basic = 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')
const call = (method, path, body, headers = {}) =>
  fetch(base + path, {
    method,
    headers: { Authorization: basic, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
const check = (condition, what) => {
  if (!condition) throw new Error(what)
  console.log(`  ok  ${what}`)
}

let failed = false
try {
  console.log(`Smoke test against ${base}`)
  for (let waited = 0; ; waited += 250) {
    if (exited !== null) throw new Error(`the server stopped on its own, with code ${exited}`)
    if (
      await fetch(`${base}/api/v1/claim`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break
    if (waited > 60_000) throw new Error('the server did not answer within 60 seconds')
    await sleep(250)
  }
  check(true, 'the built server starts and answers on the network address')
  if (DOCKER_IMAGE) {
    check(existsSync(join(dataDir, 'database.sqlite')), 'the database is in the data volume')
  } else {
    check(existsSync(databaseFile), 'the database is where the config file put it')
    check(!existsSync(join(work, 'data', 'database.sqlite')), 'and not in the data folder')
  }

  const page = await fetch(`${base}/`)
  check(page.ok && (await page.text()).includes('<div id="app"'), 'the web UI is served')

  const claim = await fetch(`${base}/api/v1/claim`, {
    method: 'POST',
    headers: { 'X-Komga-Email': EMAIL, 'X-Komga-Password': PASSWORD },
  })
  check(claim.ok, 'the administrator is created')

  const created = await call('POST', '/api/v1/libraries', {
    name: 'Smoke',
    root: DOCKER_IMAGE ? '/books' : library,
    importComicInfoBook: true,
    importComicInfoSeries: true,
    scanCbx: true,
  })
  check(created.ok, 'a library is added')

  let books = []
  for (let waited = 0; ; waited += 500) {
    const listed = await call('POST', '/api/v1/books/list?size=20&sort=metadata.numberSort,asc', {})
    books = listed.ok ? (await listed.json()).content : []
    if (books.length === 3 && books.every((book) => book.media.status === 'READY')) break
    if (waited > 60_000)
      throw new Error(`the scan did not finish: ${JSON.stringify(books.map((book) => [book.name, book.media.status]))}`)
    await sleep(500)
  }
  check(true, 'the scan finds the three books and the worker threads analyse them')
  check(
    books.some((book) => book.name === 'Volume 2' && book.metadata.number === '2.5' && book.media.pagesCount === 3),
    'a book has its pages counted and its number read from ComicInfo',
  )

  const series = await (await call('POST', '/api/v1/series/list?size=20', {})).json()
  check(
    series.content
      .map((item) => item.metadata.title)
      .sort()
      .join() === 'Akira,Berserk',
    'the series are listed',
  )

  const book = books.find((item) => item.name === 'Volume 1')
  const image = await call('GET', `/api/v1/books/${book.id}/pages/2`)
  check(image.ok && Buffer.from(await image.arrayBuffer()).equals(pages[1]), 'a page is served, byte for byte')

  let poster
  for (let waited = 0; waited <= 20_000; waited += 500) {
    poster = await call('GET', `/api/v1/books/${book.id}/thumbnail`)
    if (poster.ok) break
    await sleep(500)
  }
  check(poster.ok && String(poster.headers.get('content-type')).startsWith('image/'), 'a poster is made and served')

  const session = await call('GET', '/api/v2/users/me')
  check(session.ok, 'signing in works')

  const saved = await call('PATCH', `/api/v1/books/${book.id}/read-progress`, { page: 2 })
  const after = await (await call('GET', `/api/v1/books/${book.id}`)).json()
  check(saved.ok && after.readProgress?.page === 2, 'a reading position is saved')
} catch (error) {
  failed = true
  console.error(`\nSMOKE TEST FAILED: ${error.message}`)
}

server.kill('SIGTERM')
for (let waited = 0; exited === null && waited < 10_000; waited += 100) await sleep(100)
if (exited === null) {
  server.kill('SIGKILL')
  if (!failed && process.platform !== 'win32') {
    failed = true
    console.error('SMOKE TEST FAILED: the server did not stop when asked to')
  }
} else if (!failed) {
  console.log('  ok  the server stops when asked to')
}
await sleep(300)
rmSync(work, { recursive: true, force: true, maxRetries: 5 })
console.log(failed ? '' : '\nSmoke test passed.')
process.exit(failed ? 1 : 0)
