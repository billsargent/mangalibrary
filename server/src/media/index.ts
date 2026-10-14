import { open, readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { openEpub } from './epub.js'
import { containerFor, isImageEntry, MEDIA_TYPES, mediaTypeFor, naturalCompare, type ContainerKind } from './kinds.js'
import { openPdf } from './pdf.js'
import { ANALYSIS_ERRORS, BookProblem, fileProblem } from './problems.js'
import { openRar } from './rar.js'
import type { BookContents, FileEntry, PageEntry } from './types.js'
import { openZip, type Container } from './zip.js'

export type { BookContents, PageEntry } from './types.js'
export { containerFor, MEDIA_TYPES } from './kinds.js'

function imagePages(container: Container): PageEntry[] {
  return container.entries
    .filter(isImageEntry)
    .sort(naturalCompare)
    .map((fileName) => ({
      fileName,
      mediaType: mediaTypeFor(fileName),
      size: container.sizes.get(fileName) ?? null,
    }))
}

function allFiles(container: Container): FileEntry[] {
  return container.entries
    .slice()
    .sort(naturalCompare)
    .map((fileName) => ({
      fileName,
      mediaType: mediaTypeFor(fileName),
      size: container.sizes.get(fileName) ?? 0,
    }))
}

/**
 * Open a book file and describe what is inside it.
 *
 * The container is decided by the file name, because that is what the library
 * settings were about when the file was accepted, and a reader asking for page
 * three of a book does not want the server to guess again. A caller that holds a
 * file whose name says nothing - a temporary rewrite of a book, before it replaces
 * the original - can state the container instead.
 *
 * A CBZ or an EPUB is read from disk an entry at a time and never held whole. A
 * CBR and a PDF are: the libraries that read them want the whole file, so those
 * two still cost their size in memory while they are open.
 */
/**
 * The container a file is, by its name - and, where the name says ZIP or RAR, by its
 * first bytes, because the two are often named for each other: a RAR renamed `.cbz`
 * is common, and read as a ZIP it fails. The reference looks at the content the same
 * way. A PDF or an EPUB is taken at its name.
 */
export async function containerOf(path: string): Promise<ContainerKind | null> {
  const named = containerFor(basename(path))
  if (named !== 'ZIP' && named !== 'RAR') return named
  let handle
  try {
    handle = await open(path, 'r')
    const head = Buffer.alloc(8)
    const { bytesRead } = await handle.read(head, 0, 8, 0)
    const start = head.subarray(0, bytesRead)
    if (start.subarray(0, 2).toString('latin1') === 'PK') return 'ZIP'
    if (start.subarray(0, 4).toString('latin1') === 'Rar!') return 'RAR'
    if (start.subarray(0, 4).toString('latin1') === '%PDF') return 'PDF'
    return named
  } catch {
    return named
  } finally {
    await handle?.close()
  }
}

export async function openBook(path: string, stated?: ContainerKind): Promise<BookContents> {
  const kind = stated ?? (await containerOf(path))
  if (kind === null) throw new Error(`${basename(path)} is not a book container this server reads`)

  if (kind === 'PDF') {
    const pdf = await openPdf(await readFile(path))
    return {
      kind,
      mediaType: MEDIA_TYPES.PDF,
      pageCount: pdf.pageCount,
      pages: pdf.pages(),
      files: [],
      readPage: async (pageNumber) => {
        if (pageNumber < 1 || pageNumber > pdf.pageCount) throw new Error(`page ${pageNumber} is out of range`)
        return pdf.readPage(pageNumber)
      },
      readPageRaw: async (pageNumber) => pdf.readPageAsPdf(pageNumber),
      readResource: async (name) => {
        throw new Error(`a PDF has no ${name} inside it`)
      },
      close: () => pdf.close(),
    }
  }

  if (kind === 'RAR') {
    const container = await openRar(path)
    const pages = imagePages(container)
    return {
      kind,
      mediaType: MEDIA_TYPES.RAR,
      pageCount: pages.length,
      pages,
      files: allFiles(container),
      readPage: async (pageNumber) => {
        const page = pages[pageNumber - 1]
        if (!page) throw new Error(`page ${pageNumber} is out of range`)
        return container.read(page.fileName)
      },
      readResource: (name) => container.read(name),
      close: () => container.close(),
    }
  }

  if (kind === 'EPUB') {
    // A file named as an EPUB that cannot be opened as one - no package, no spine,
    // not a zip at all - is the reference's "EPUB file has wrong media type". A
    // file that is not there is not that.
    const epub = await openEpub(path).catch((error: unknown) => {
      if (fileProblem(error) !== null || error instanceof BookProblem) throw error
      throw new BookProblem((error as Error).message, ANALYSIS_ERRORS.notAnEpub)
    })
    return {
      kind,
      mediaType: MEDIA_TYPES.EPUB,
      pageCount: epub.pages.length,
      pages: epub.pages,
      files: epub.files,
      epub: {
        toc: epub.toc,
        tocUnreadable: epub.tocUnreadable,
        missingResources: epub.missingResources,
        divinaCompatible: epub.divinaCompatible,
        packageDocument: epub.packageDocument,
        cover: epub.cover,
      },
      readPage: async (pageNumber) => {
        const page = epub.pages[pageNumber - 1]
        if (!page) throw new Error(`page ${pageNumber} is out of range`)
        return epub.container.read(page.fileName)
      },
      readResource: (name) => epub.container.read(name),
      close: () => epub.container.close(),
    }
  }

  const container = await openZip(path)
  const pages = imagePages(container)
  return {
    kind,
    mediaType: MEDIA_TYPES.ZIP,
    pageCount: pages.length,
    pages,
    files: allFiles(container),
    readPage: async (pageNumber) => {
      const page = pages[pageNumber - 1]
      if (!page) throw new Error(`page ${pageNumber} is out of range`)
      return container.read(page.fileName)
    },
    readResource: (name) => container.read(name),
    close: () => container.close(),
  }
}
