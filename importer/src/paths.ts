import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Where the books are now, given where Komga had them.
 *
 * Komga stores every location as a `file:` URL of the machine it ran on -
 * `file:/srv/manga/One%20Piece/v01.cbz` - and this server stores the URL that
 * `pathToFileURL` gives on the machine it runs on. The two differ even when the
 * folders have not moved (`file:/` against `file:///`), and a scan compares them
 * as text: a location carried over as it was would make the first scan think every
 * book new and every imported one gone. So every location is rewritten, and a
 * folder that has moved is found through the mapping the person importing gives.
 */

export interface PathMapping {
  /** A folder as Komga saw it, `/srv/manga`. */
  from: string
  /** Where that folder may be now, tried in order: the first that holds the library wins. */
  to: string[]
}

/** Where a library was, and where it is now. */
export interface LibraryPlacement {
  id: string
  name: string
  komga: string
  root: string
  /** Whether the new root is a folder that exists here. */
  found: boolean
  /**
   * The new root as the system resolves it - through links, and a mapped drive to
   * the share behind it. A scan names every book from this, so the import must too.
   */
  resolved: string
}

/** `/a/b/` and `/a/b` are one folder; Komga writes roots with the slash and this server without. */
function trimmed(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/** Forward slashes, for comparing a Komga path with a mapping typed on any system. */
const forward = (path: string) => trimmed(path.replaceAll('\\', '/'))

/** The path a Komga `file:` URL names, as Komga's machine spelled it. */
export function komgaPath(url: string): string {
  let rest = url.replace(/^file:/i, '')
  // `file:///srv/x` and `file:/srv/x` both mean /srv/x; a Windows one is `file:///C:/x`.
  rest = rest.replace(/^\/\/(?=\/)/, '')
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // A stray `%` that is not an escape is a character of the name.
  }
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1)
  return trimmed(rest)
}

/** `--map old=new`, as typed: the first `=` divides them, so a folder may contain one after it. */
export function parseMapping(text: string): { from: string; to: string } {
  const at = text.indexOf('=')
  if (at <= 0 || at === text.length - 1) throw new Error(`--map wants old=new, not "${text}"`)
  return { from: text.slice(0, at), to: text.slice(at + 1) }
}

/** Mappings given more than once for one folder become one mapping with several places to try. */
export function groupMappings(pairs: readonly { from: string; to: string }[]): PathMapping[] {
  const byFrom = new Map<string, PathMapping>()
  for (const pair of pairs) {
    const key = forward(pair.from)
    const known = byFrom.get(key)
    if (known) known.to.push(pair.to)
    else byFrom.set(key, { from: key, to: [pair.to] })
  }
  return [...byFrom.values()]
}

/** The part of `path` below `folder`, or null when it is not below it. */
function below(path: string, folder: string): string | null {
  const p = forward(path)
  if (p === folder) return ''
  return p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : null
}

const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A folder as the system resolves it, as a scan resolves a library's root; as given when it is not there. */
function resolvedPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export class Relocator {
  private readonly mappings: PathMapping[]
  private readonly libraries: LibraryPlacement[] = []

  constructor(mappings: readonly PathMapping[]) {
    // The most particular mapping first, so `/srv/manga/old` can go elsewhere than `/srv/manga`.
    this.mappings = [...mappings].sort((left, right) => right.from.length - left.from.length)
  }

  /** The places a Komga path may be now, most likely first. */
  private candidates(path: string): string[] {
    for (const mapping of this.mappings) {
      const rest = below(path, mapping.from)
      if (rest === null) continue
      return mapping.to.map((to) => (rest === '' ? trimmed(to) : join(to, rest)))
    }
    return [path]
  }

  /** Decide where a library is now: the first place it might be that exists, or else the first. */
  placeLibrary(id: string, name: string, rootUrl: string): LibraryPlacement {
    const komga = komgaPath(rootUrl)
    const candidates = this.candidates(komga)
    const found = candidates.find(isFolder)
    const root = found ?? candidates[0]!
    const placement = {
      id,
      name,
      komga: forward(komga),
      root,
      found: found !== undefined,
      resolved: resolvedPath(root),
    }
    this.libraries.push(placement)
    // The most particular library first, for a library inside another's folder.
    this.libraries.sort((left, right) => right.komga.length - left.komga.length)
    return placement
  }

  /** Where a Komga path is now: inside its library's new root when it has one. */
  path(komgaUrl: string): string {
    const path = komgaPath(komgaUrl)
    for (const library of this.libraries) {
      const rest = below(path, library.komga)
      if (rest !== null) return rest === '' ? library.resolved : join(library.resolved, rest)
    }
    return this.candidates(path)[0]!
  }

  /** The URL this server would have stored for the same file or folder. */
  url(komgaUrl: string): string {
    return pathToFileURL(this.path(komgaUrl)).href
  }

  placements(): readonly LibraryPlacement[] {
    return this.libraries
  }
}

/**
 * When a file was last changed, the way a scan reads it - the later of its creation
 * and modification times, as Komga and this server both take it - or null when
 * there is no such file.
 */
export function fileTime(path: string): string | null {
  try {
    const info = statSync(path)
    if (!info.isFile()) return null
    return new Date(Math.max(info.birthtimeMs, info.mtimeMs)).toISOString()
  } catch {
    return null
  }
}
