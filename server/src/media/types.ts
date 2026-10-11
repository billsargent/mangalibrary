import type { ContainerKind } from './kinds.js'

/** One page of a book, as it is stored in the media tables. */
export interface PageEntry {
  fileName: string
  mediaType: string
  /** Bytes, when the container knows before reading; PDF pages are rendered. */
  size: number | null
}

/** A file inside a book, which an EPUB reader needs as a resource. */
export interface FileEntry {
  fileName: string
  mediaType: string
  size: number
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
  readResource(name: string): Promise<Buffer>
  close(): void
}
