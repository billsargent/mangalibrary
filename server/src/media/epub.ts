import { isImageEntry, mediaTypeFor, naturalCompare } from './kinds.js'
import type { PageEntry, Position, TocEntry } from './types.js'
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
  /** The package document as it was read, which is where its metadata lives. */
  xml: string
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

/**
 * Resolve a table of contents link against the document that holds it, keeping what
 * follows the `#`: an entry can point into the middle of a chapter. A bare
 * `#fragment` points into that document itself.
 */
function resolveTocHref(document: string, href: string): string {
  const at = href.indexOf('#')
  const path = at < 0 ? href : href.slice(0, at)
  const fragment = at < 0 ? '' : href.slice(at)
  const resolved = path === '' ? document : resolveHref(directoryOf(document), path)
  return fragment.length > 1 ? `${resolved}${fragment}` : resolved
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

  return { manifest, spine, tocId: attribute(spineTag, 'toc'), base, xml: opf }
}

async function readText(container: Container, name: string): Promise<string> {
  return (await container.read(name)).toString('utf8')
}

/**
 * Table of contents: the navigation document when there is one, else the NCX.
 * `unreadable` says one was named and none could be read, which is different
 * from a book that has none.
 */
async function readToc(container: Container, pkg: EpubPackage): Promise<{ toc: TocEntry[]; unreadable: boolean }> {
  // A package document can name a navigation document that is not in the archive,
  // which makes the table of contents empty rather than the book unreadable.
  const nav = [...pkg.manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  if (nav) {
    const markup = await readTextOrNull(container, nav.href)
    if (markup !== null) return { toc: readNavToc(markup, nav.href), unreadable: false }
  }

  const ncx = pkg.tocId === null ? undefined : pkg.manifest.get(pkg.tocId)
  if (ncx) {
    const markup = await readTextOrNull(container, ncx.href)
    if (markup !== null) return { toc: readNcxToc(markup, ncx.href), unreadable: false }
  }

  return { toc: [], unreadable: nav !== undefined || ncx !== undefined }
}

async function readTextOrNull(container: Container, name: string): Promise<string | null> {
  try {
    return await readText(container, name)
  } catch {
    return null
  }
}

/** `<nav epub:type="toc">` holds nested `<ol>` lists of links. */
function readNavToc(xml: string, document: string): TocEntry[] {
  const navStart = /<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>/i.exec(xml)
  const from = navStart ? navStart.index + navStart[0].length : 0
  const to = navStart ? xml.indexOf('</nav>', from) : xml.length
  const section = xml.slice(from, to < 0 ? xml.length : to)

  // Each `<li>` is an entry: its title the link in it, or a heading (`<span>`) when it
  // only groups others; an `<ol>` inside it holds its children.
  const roots: Draft[] = []
  const open: Draft[] = []
  const token = /<(\/?)(li|a|span)\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = token.exec(section)) !== null) {
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    const current = open.at(-1)
    if (name === 'li') {
      if (closing) open.pop()
      else {
        const entry: Draft = { title: '', href: null, children: [] }
        ;(current ? current.children : roots).push(entry)
        open.push(entry)
      }
    } else if (!closing && current && current.title === '') {
      const close = section.indexOf(`</${name}`, token.lastIndex)
      current.title = stripTags(section.slice(token.lastIndex, close < 0 ? undefined : close))
      const href = name === 'a' ? attribute(match[0], 'href') : null
      if (href !== null) current.href = resolveTocHref(document, href)
    }
  }
  return finish(roots)
}

/** An NCX holds `navPoint` elements, nested, with `navLabel/text` and `content/src`. */
function readNcxToc(xml: string, document: string): TocEntry[] {
  const roots: Draft[] = []
  const open: Draft[] = []
  const token = /<(\/?)(navPoint|text|content)\b([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = token.exec(xml)) !== null) {
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    const current = open.at(-1)
    if (name === 'navpoint') {
      if (closing) open.pop()
      else {
        const entry: Draft = { title: '', href: null, children: [] }
        ;(current ? current.children : roots).push(entry)
        open.push(entry)
      }
    } else if (closing || !current) continue
    else if (name === 'text' && current.title === '') {
      const close = xml.indexOf('</text', token.lastIndex)
      current.title = stripTags(xml.slice(token.lastIndex, close < 0 ? undefined : close))
    } else if (name === 'content' && current.href === null) {
      const src = attribute(match[0], 'src')
      if (src !== null) current.href = resolveTocHref(document, src)
    }
  }
  return finish(roots)
}

/** An entry as it is read, before it is known whether it links anywhere. */
interface Draft {
  title: string
  href: string | null
  children: Draft[]
}

/**
 * Entries as they are kept. One without a title is dropped, its children taking its
 * place; a heading without a link opens where its first child does.
 */
function finish(drafts: Draft[]): TocEntry[] {
  return drafts.flatMap((draft): TocEntry[] => {
    const children = finish(draft.children)
    const href = draft.href ?? children[0]?.href
    if (draft.title === '' || href === undefined) return children
    return [{ title: draft.title, href, children }]
  })
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
 * The cover image's href, or null when the package document names none.
 *
 * EPUB 3 marks the item with `properties="cover-image"`; EPUB 2 points at it from
 * a `meta` element by id, which is what most of the books on disk still do.
 */
function coverOf(pkg: EpubPackage): string | null {
  const marked = [...pkg.manifest.values()].find((item) => item.properties.split(/\s+/).includes('cover-image'))
  if (marked !== undefined) return marked.href

  const meta = /<meta\b[^>]*name\s*=\s*"cover"[^>]*>/i.exec(pkg.xml)
  const id = meta === null ? null : (/content\s*=\s*"([^"]*)"/i.exec(meta[0])?.[1] ?? null)
  return id === null ? null : (pkg.manifest.get(id)?.href ?? null)
}

/**
 * Read an EPUB through its container and package documents.
 *
 * A fixed-layout EPUB whose spine points straight at images is read as pages of
 * images, which is what makes it Divina compatible; anything else exposes the
 * spine documents as its pages.
 */
export async function openEpub(source: string | Buffer): Promise<{
  container: Container
  pages: { fileName: string; mediaType: string; size: number | null }[]
  files: { fileName: string; mediaType: string; size: number }[]
  toc: TocEntry[]
  tocUnreadable: boolean
  missingResources: string[]
  divinaCompatible: boolean
  packageDocument: string
  cover: string | null
}> {
  const container = await openZip(source)
  try {
    return await describeEpub(container)
  } catch (error) {
    // The caller never receives an archive that could not be described, so it is
    // closed here or by nobody.
    container.close()
    throw error
  }
}

async function describeEpub(container: Container): Promise<{
  container: Container
  pages: { fileName: string; mediaType: string; size: number | null }[]
  files: { fileName: string; mediaType: string; size: number }[]
  toc: TocEntry[]
  tocUnreadable: boolean
  missingResources: string[]
  divinaCompatible: boolean
  packageDocument: string
  cover: string | null
}> {
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

  const { toc, unreadable } = await readToc(container, pkg)
  return {
    container,
    pages,
    files,
    toc,
    tocUnreadable: unreadable,
    missingResources: [...pkg.manifest.values()]
      .map((item) => item.href)
      .filter((href) => !container.sizes.has(href))
      .sort(naturalCompare),
    divinaCompatible,
    packageDocument: pkg.xml,
    cover: coverOf(pkg),
  }
}

/** How much of a resource one position covers, as the Readium algorithm does. */
const POSITION_LENGTH = 1024

/**
 * The positions of a book: one every 1024 bytes of each resource.
 *
 * A reader addresses a place in a book with these rather than with a page number,
 * which is what lets a reflowable EPUB - whose text moves with the reader's font
 * and window - resume somewhere stable. A resource shorter than one step still
 * gets a single position, so a short chapter is not skipped, and the first
 * position of each resource carries the reference's Kobo span.
 */
export function computePositions(pages: PageEntry[]): Position[] {
  // Built without `totalProgression`, which is only known once they are all here.
  const steps: {
    href: string
    type: string
    koboSpan?: string
    locations: { progression: number; position: number }
  }[] = []
  for (const page of pages) {
    const count = Math.max(1, Math.ceil((page.size ?? 0) / POSITION_LENGTH))
    for (let index = 0; index < count; index += 1) {
      steps.push({
        href: page.fileName,
        type: page.mediaType,
        ...(index === 0 ? { koboSpan: 'kobo.1.1' } : {}),
        locations: { progression: index / count, position: steps.length + 1 },
      })
    }
  }

  const total = steps.length
  return steps.map((step) => ({
    ...step,
    locations: { ...step.locations, totalProgression: step.locations.position / total },
  }))
}
