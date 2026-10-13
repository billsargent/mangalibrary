import type { ContainerKind } from './kinds.js'

/** One page of a book, as it is stored in the media tables. */
export interface PageEntry {
  fileName: string
  mediaType: string
  /** Bytes, when the container knows before reading; PDF pages are rendered. */
  size: number | null
  /**
   * The size in pixels, when the container knows it without reading the page: a
   * PDF does, because it decides how large each page is drawn.
   */
  width?: number
  height?: number
}

/** A file inside a book, which an EPUB reader needs as a resource. */
export interface FileEntry {
  fileName: string
  mediaType: string
  size: number
}

/**
 * A Readium position: a fixed-size step through a book.
 *
 * A reader addresses a place in a book with these rather than with a page number,
 * so that a reflowable EPUB - whose text moves with the reader's font and window
 * - still has somewhere stable to resume from.
 */
export interface Position {
  href: string
  type: string
  /** Set when the position is the first of a resource, as the reference does. */
  koboSpan?: string
  locations: {
    /** Progression within the resource, between 0 and 1. */
    progression: number
    /** Index of the position in the whole book, starting at 1. */
    position: number
    /** Progression within the whole book, between 0 and 1. */
    totalProgression: number
  }
}

export interface TocEntry {
  title: string
  href: string
  children: TocEntry[]
}

/** What the EPUB reader needs beyond a page list. */
export interface EpubInfo {
  toc: TocEntry[]
  /**
   * Whether every page is an image.
   *
   * A fixed-layout, image-only EPUB can be read by the Divina reader, which is
   * what the reference calls Divina compatible, and what the reader uses to
   * decide which way to open the book.
   */
  divinaCompatible: boolean
  /**
   * The package document, as it was read.
   *
   * An EPUB keeps its title, its authors, its publisher and the collection it
   * belongs to here, so the metadata reader wants the document itself rather than
   * a second set of fields to keep in step.
   */
  packageDocument: string
  /**
   * The href of the cover image inside the archive, or null when it names none.
   *
   * A reflowable EPUB has no page that is an image, so its cover is the only thing
   * a poster can be made of.
   */
  cover: string | null
}

/** An open book. Closing releases whatever the container holds. */
export interface BookContents {
  kind: ContainerKind
  mediaType: string
  pageCount: number
  pages: PageEntry[]
  files: FileEntry[]
  epub?: EpubInfo
  readPage(pageNumber: number): Promise<Buffer>
  /** One page as a document of its own, for a container whose pages are not images: a PDF. */
  readPageRaw?(pageNumber: number): Promise<Buffer>
  readResource(name: string): Promise<Buffer>
  close(): void
}
