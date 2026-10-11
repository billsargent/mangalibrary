import type { InspectedPage } from './analyze.js'

/**
 * A book that has been scanned but not imported.
 *
 * It is not part of the library, so it has no database row: like the reference,
 * it is held in memory and forgotten an hour after it was last touched. A scan
 * produces these with `status` UNKNOWN and nothing known about the contents;
 * analysing one fills in the pages, the files and the media type.
 */
export interface TransientBook {
  id: string
  name: string
  path: string
  fileSize: number
  fileLastModified: Date
  /** When the record was created or last analysed, for the page `Last-Modified`. */
  lastModified: Date
  status: string
  mediaType: string | null
  pages: InspectedPage[]
  files: string[]
  comment: string | null
}

const HOUR_MS = 60 * 60 * 1000

/**
 * The transient books of one server instance.
 *
 * Expiration slides on access, matching the reference's cache: a book that is
 * still being worked with does not vanish underneath the client. A restart
 * forgets everything, which is correct - nothing about an import that has not
 * happened should outlive the process.
 */
export class TransientBookStore {
  private readonly books = new Map<string, { value: TransientBook; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number = HOUR_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): TransientBook | undefined {
    const entry = this.books.get(id)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.books.delete(id)
      return undefined
    }
    entry.expiresAt = this.now() + this.ttlMs
    return entry.value
  }

  save(book: TransientBook): void {
    this.books.set(book.id, { value: book, expiresAt: this.now() + this.ttlMs })
  }
}
