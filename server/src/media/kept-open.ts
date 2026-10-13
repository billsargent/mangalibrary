/**
 * One book kept open between the reads of its pages.
 *
 * A PDF has to be loaded whole and parsed before any page of it can be drawn, and
 * a reader asks for its pages one request at a time. Opened for each, a book of
 * three hundred pages is loaded three hundred times. So the book last read from
 * stays open for a short while, and the next page of it costs only the page.
 *
 * One book, not several: an open PDF is its whole file in memory, and this lives
 * on a reader thread, of which there are few. Reading from another book lets the
 * first go. So does a minute with nothing asked, or the file changing on disk.
 */

import { stat } from 'node:fs/promises'

import { openBook } from './index.js'
import type { BookContents } from './types.js'

/** How long a book nobody is reading from is kept. */
const KEPT_FOR_MS = 60_000

interface Kept {
  path: string
  /** The file's size and date, which change when it is replaced. */
  version: string
  book: BookContents
  timer: NodeJS.Timeout
}

let kept: Kept | null = null

function letGo(): void {
  if (kept === null) return
  clearTimeout(kept.timer)
  try {
    kept.book.close()
  } catch {
    // A book that will not close is let go of all the same.
  }
  kept = null
}

/**
 * The book at a path, opened now or still open from the last read.
 *
 * The caller does not close it: it is closed when it is let go of. Throws what
 * opening a book throws.
 */
export async function keptOpen(path: string): Promise<BookContents> {
  const info = await stat(path)
  const version = `${info.size}:${info.mtimeMs}`

  if (kept !== null && (kept.path !== path || kept.version !== version)) letGo()
  if (kept === null) {
    kept = { path, version, book: await openBook(path), timer: setTimeout(letGo, KEPT_FOR_MS) }
  } else {
    kept.timer.refresh()
  }
  // A thread with nothing else to do is not kept alive by a book it is holding.
  kept.timer.unref()
  return kept.book
}

/** Let go of whatever is open, which a test does between cases. */
export function closeKeptBook(): void {
  letGo()
}
