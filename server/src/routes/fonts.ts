import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/session.js'
import type { RouteOptions } from './libraries.js'

/** The extensions a font family may be made of. */
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf'])

interface FontFile {
  name: string
  path: string
}

interface FontFamily {
  name: string
  files: FontFile[]
}

/** Font characteristics are read from the file name, as the reference does. */
function characteristics(fileName: string): { style: string; weight: string } {
  return {
    style: fileName.toLowerCase().includes('italic') ? 'italic' : 'normal',
    weight: fileName.toLowerCase().includes('bold') ? 'bold' : 'normal',
  }
}

function formatFor(extension: string): string {
  const value = extension.toLowerCase()
  if (value === 'ttf') return 'truetype'
  if (value === 'otf') return 'opentype'
  return value
}

/**
 * The fonts an EPUB reader can offer.
 *
 * A family is a directory under the fonts directory and its members are the files
 * in it, which is how the reference lays it out and how an operator drops a font
 * in. The directory is read per request rather than once at startup, so adding a
 * font does not need a restart; it is a handful of names, not a scan.
 */
async function readFamilies(fontsDir: string): Promise<FontFamily[]> {
  let entries: string[]
  try {
    entries = await readdir(fontsDir)
  } catch {
    // No fonts directory is not an error: it means no fonts have been added.
    return []
  }

  const families: FontFamily[] = []
  for (const name of entries.sort()) {
    const directory = join(fontsDir, name)
    const info = await stat(directory).catch(() => null)
    if (!info?.isDirectory()) continue

    const members = await readdir(directory).catch(() => [] as string[])
    const files: FontFile[] = []
    for (const member of members.sort()) {
      if (!FONT_EXTENSIONS.has(extname(member).slice(1).toLowerCase())) continue
      const path = join(directory, member)
      const memberInfo = await stat(path).catch(() => null)
      if (memberInfo?.isFile()) files.push({ name: member, path })
    }

    if (files.length > 0) families.push({ name, files })
  }

  return families
}

function findFamily(families: FontFamily[], name: string): FontFamily | undefined {
  return families.find((family) => family.name === name)
}

/** A file inside a family, refusing anything that escapes the fonts directory. */
function findFile(fontsDir: string, family: FontFamily, name: string): string | undefined {
  const candidate = family.files.find((file) => file.name === name)
  if (!candidate) return undefined

  const root = resolve(fontsDir)
  const path = resolve(candidate.path)
  return path === root || path.startsWith(root + sep) ? path : undefined
}

/**
 * `@font-face` blocks for a family, grouped by style and weight.
 *
 * Several files can describe the same face in different formats, which is what
 * the `src` list is for.
 */
function familyCss(family: FontFamily): string {
  const groups = new Map<string, FontFile[]>()
  for (const file of family.files) {
    const { style, weight } = characteristics(file.name)
    const key = `${style}/${weight}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(file)
    else groups.set(key, [file])
  }

  const blocks: string[] = []
  for (const files of groups.values()) {
    const first = files[0]
    if (!first) continue
    const { style, weight } = characteristics(first.name)

    const sources = files
      .map((file) => `url('${file.name}') format('${formatFor(extname(file.name).slice(1))}')`)
      .join(',')

    blocks.push(
      [
        '@font-face {',
        `    font-family: '${family.name}';`,
        `    src: ${sources};`,
        `    font-weight: ${weight};`,
        `    font-style: ${style};`,
        '}',
      ].join('\n'),
    )
  }

  return `${blocks.join('\n\n')}\n`
}

/** The fonts an operator has made available, and the styles the EPUB reader uses. */
export async function registerFontRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  app.get('/api/v1/fonts/families', { preHandler: requireAuth }, async () =>
    (await readFamilies(opts.fontsDir)).map((family) => family.name),
  )

  // The reader loads these two from inside a book, where it has no session to
  // send, so they are served without credentials - as the reference does.
  app.get<{ Params: { fontFamily: string; fontFile: string } }>(
    '/api/v1/fonts/resource/:fontFamily/:fontFile',
    async (req, reply) => {
      const families = await readFamilies(opts.fontsDir)
      const family = findFamily(families, req.params.fontFamily)
      const path = family === undefined ? undefined : findFile(opts.fontsDir, family, req.params.fontFile)
      if (path === undefined) return reply.code(404).send({ message: 'Font not found' })

      const bytes = await readFile(path)
      const extension = extname(path).slice(1).toLowerCase()
      return reply
        .header('content-type', `font/${extension}`)
        .header('content-disposition', `attachment; filename="${req.params.fontFile}"`)
        .send(bytes)
    },
  )

  app.get<{ Params: { fontFamily: string } }>('/api/v1/fonts/resource/:fontFamily/css', async (req, reply) => {
    const families = await readFamilies(opts.fontsDir)
    const family = findFamily(families, req.params.fontFamily)
    if (family === undefined) return reply.code(404).send({ message: 'Font not found' })

    return reply
      .header('content-type', 'text/css')
      .header('content-disposition', `attachment; filename="${family.name}.css"`)
      .send(familyCss(family))
  })
}
