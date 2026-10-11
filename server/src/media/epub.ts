import { isImageEntry, mediaTypeFor, naturalCompare } from './kinds.js'
import type { TocEntry } from './types.js'
import { openZip, type Container } from './zip.js'

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface EpubPackage {
  manifest: Map<string, ManifestItem>
  spine: string[]
  tocId: string | null
  base: string
}

/**
 * The XML in an EPUB is a handful of small, fixed documents, so they are read with
 * targeted patterns rather than by taking on an XML dependency, the same way the
 * ComicRack reading list is parsed.
 */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return match?.[1] ?? null
}

function tagsOf(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []
}

/** Resolve an href against the directory that holds it. */
function resolveHref(base: string, href: string): string {
  const path = href.split('#')[0] ?? href
  if (path.startsWith('/')) return path.slice(1)

  const segments = [...base.split('/').filter((segment) => segment !== ''), ...path.split('/')]
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join('/')
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

async function readPackage(container: Container): Promise<EpubPackage | null> {
  const containerXml = await readText(container, 'META-INF/container.xml')
  const rootfile = tagsOf(containerXml, 'rootfile')[0]
  const opfPath = rootfile === undefined ? null : attribute(rootfile, 'full-path')
  if (opfPath === null) return null

  const opf = await readText(container, opfPath)
  const base = directoryOf(opfPath)

  const manifest = new Map<string, ManifestItem>()
  for (const tag of tagsOf(opf, 'item')) {
    const id = attribute(tag, 'id')
    const href = attribute(tag, 'href')
    if (id === null || href === null) continue
    manifest.set(id, {
      id,
      href: resolveHref(base, href),
      mediaType: attribute(tag, 'media-type') ?? mediaTypeFor(href),
      properties: attribute(tag, 'properties') ?? '',
    })
  }

  const spineTag = tagsOf(opf, 'spine')[0] ?? ''
  const spine: string[] = []
  for (const tag of tagsOf(opf, 'itemref')) {
    const idref = attribute(tag, 'idref')
    const href = idref === null ? null : manifest.get(idref)?.href
    if (href) spine.push(href)
  }

  return { manifest, spine, tocId: attribute(spineTag, 'toc'), base }
}

async function readText(container: Container, name: string): Promise<string> {
  return (await container.read(name)).toString('utf8')
}

/** Table of contents: the navigation document when there is one, else the NCX. */
async function readToc(container: Container, pkg: EpubPackage): Promise<TocEntry[]> {
  // A package document can name a navigation document that is not in the archive,
  // which makes the table of contents empty rather than the book unreadable.
  const nav = [...pkg.manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  if (nav) {
    const markup = await readTextOrNull(container, nav.href)
    if (markup !== null) return readNavToc(markup, directoryOf(nav.href))
  }

  const ncx = pkg.tocId === null ? undefined : pkg.manifest.get(pkg.tocId)
  if (ncx) {
    const markup = await readTextOrNull(container, ncx.href)
    if (markup !== null) return readNcxToc(markup, directoryOf(ncx.href))
  }

  return []
}

async function readTextOrNull(container: Container, name: string): Promise<string | null> {
  try {
    return await readText(container, name)
  } catch {
    return null
  }
}

/** `<nav epub:type="toc">` holds nested `<ol>` lists of links. */
function readNavToc(xml: string, base: string): TocEntry[] {
  const navStart = /<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>/i.exec(xml)
  const from = navStart ? navStart.index + navStart[0].length : 0
  const to = navStart ? xml.indexOf('</nav>', from) : xml.length
  const section = xml.slice(from, to < 0 ? xml.length : to)

  return entriesFromMarkup(section, base)
}

function entriesFromMarkup(markup: string, base: string): TocEntry[] {
  const entries: TocEntry[] = []
  const link = /<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  let match: RegExpExecArray | null
  while ((match = link.exec(markup)) !== null) {
    const href = match[1]
    const title = stripTags(match[2] ?? '')
    if (href === undefined || title === '') continue
    entries.push({ title, href: resolveHref(base, href), children: [] })
  }

  return entries
}

/** An NCX holds `navPoint` elements with `navLabel/text` and `content/src`. */
function readNcxToc(xml: string, base: string): TocEntry[] {
  const entries: TocEntry[] = []
  const navPoint = /<navPoint\b[\s\S]*?<\/navPoint>/gi

  let match: RegExpExecArray | null
  while ((match = navPoint.exec(xml)) !== null) {
    const label = /<text\b[^>]*>([\s\S]*?)<\/text>/i.exec(match[0])
    const content = /<content\b[^>]*src\s*=\s*"([^"]+)"/i.exec(match[0])
    if (!label || !content) continue
    const title = stripTags(label[1] ?? '')
    const href = content[1]
    if (title === '' || href === undefined) continue
    entries.push({ title, href: resolveHref(base, href), children: [] })
  }

  return entries
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read an EPUB through its container and package documents.
 *
 * A fixed-layout EPUB whose spine points straight at images is read as pages of
 * images, which is what makes it Divina compatible; anything else exposes the
 * spine documents as its pages.
 */
export async function openEpub(buffer: Buffer): Promise<{
  container: Container
  pages: { fileName: string; mediaType: string; size: number | null }[]
  files: { fileName: string; mediaType: string; size: number }[]
  toc: TocEntry[]
  divinaCompatible: boolean
}> {
  const container = await openZip(buffer)
  const pkg = await readPackage(container)
  if (!pkg || pkg.spine.length === 0) {
    throw new Error('the EPUB has no package document or no spine')
  }

  const spineItems = pkg.spine.map((href) => ({
    href,
    mediaType: mediaTypeFor(href),
    size: container.sizes.get(href) ?? null,
  }))

  const divinaCompatible = spineItems.every((item) => isImageEntry(item.href))
  const pages = spineItems.map((item) => ({
    fileName: item.href,
    // A page that is a document is served as one; the reader bundles it with its
    // resources.
    mediaType: item.mediaType,
    size: item.size,
  }))

  const files = container.entries
    .slice()
    .sort(naturalCompare)
    .map((fileName) => ({
      fileName,
      mediaType: mediaTypeFor(fileName),
      size: container.sizes.get(fileName) ?? 0,
    }))

  return { container, pages, files, toc: await readToc(container, pkg), divinaCompatible }
}
