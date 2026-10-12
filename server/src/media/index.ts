import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { openEpub } from './epub.js'
import { containerFor, isImageEntry, MEDIA_TYPES, mediaTypeFor, naturalCompare } from './kinds.js'
import { openPdf } from './pdf.js'
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
 * three of a book does not want the server to guess again.
 */
export async function openBook(path: string): Promise<BookContents> {
  const kind = containerFor(basename(path))
  if (kind === null) throw new Error(`${basename(path)} is not a book container this server reads`)

  const buffer = await readFile(path)

  if (kind === 'PDF') {
    const pdf = await openPdf(buffer)
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
      readResource: async (name) => {
        throw new Error(`a PDF has no ${name} inside it`)
      },
      close: () => pdf.close(),
    }
  }

  if (kind === 'RAR') {
    const container = await openRar(buffer)
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
    const epub = await openEpub(buffer)
    return {
      kind,
      mediaType: MEDIA_TYPES.EPUB,
      pageCount: epub.pages.length,
      pages: epub.pages,
      files: epub.files,
      epub: {
        toc: epub.toc,
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

  const container = await openZip(buffer)
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
