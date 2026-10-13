import sharp from 'sharp'

import { computePositions } from './epub.js'
import { openBook } from './index.js'
import { isImageEntry } from './kinds.js'
import { ANALYSIS_ERRORS, BookProblem, fileProblem } from './problems.js'
import type { EpubInfo, Position, TocEntry } from './types.js'

/**
 * Looking inside a book, without a database.
 *
 * This is kept apart from what writes the result down so that it can run on a
 * worker thread: it needs the file and nothing else, and everything it returns
 * is plain data.
 */

export type AnalysisStatus = 'READY' | 'ERROR' | 'UNSUPPORTED'

export { ANALYSIS_ERRORS }

/** A book that could not be analysed, as an inspection. */
function failed(status: AnalysisStatus, comment: string): BookInspection {
  return { status, mediaType: null, pages: [], files: [], epubToc: null, positions: null, comment }
}

async function imageSize(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const metadata = await sharp(buffer).metadata()
    return { width: metadata.width ?? null, height: metadata.height ?? null }
  } catch {
    return { width: null, height: null }
  }
}

/** One page of a book, as opening the book described it. */
export interface InspectedPage {
  fileName: string
  mediaType: string
  width: number | null
  height: number | null
  /** Bytes, when the container knows before reading; PDF pages are rendered. */
  size: number | null
}

/**
 * What opening a book tells us, before any of it is written down.
 *
 * Analysis is split in two so that the same reading serves both the scanner,
 * which persists it in the media tables, and the transient-book endpoints, which
 * have no book row to persist it against.
 */
export interface BookInspection {
  status: AnalysisStatus
  mediaType: string | null
  pages: InspectedPage[]
  files: { fileName: string; size: number }[]
  /** The table of contents of an EPUB, or null for the other containers. */
  epubToc: TocEntry[] | null
  /** The Readium positions of an EPUB, or null for the other containers. */
  positions: Position[] | null
  comment: string | null
}

/**
 * Open a book and describe what is inside it, without writing anything.
 *
 * This never throws for a bad file: a book that cannot be read comes back as an
 * error inspection, the same way the scanner records it, so a caller can show it
 * and an operator can see why.
 */
export async function inspectBook(
  path: string,
  options: { analyzeDimensions?: boolean } = {},
): Promise<BookInspection> {
  try {
    const book = await openBook(path)
    try {
      // An archive is a book because of the pictures in it. One with none is not a
      // book with no pages, it is a file that could not be made a book of - which is
      // an error to the reference too, and what stops it being listed as readable.
      if ((book.kind === 'ZIP' || book.kind === 'RAR') && book.pages.length === 0) {
        return failed('ERROR', ANALYSIS_ERRORS.noPages)
      }

      const pages: InspectedPage[] = []

      for (const [index, page] of book.pages.entries()) {
        // Dimensions are only known by decoding an image, which is the expensive
        // part of analysis, so a caller can turn it off.
        // A container that already knows - a PDF, which sets the size its pages are
        // drawn at - is taken at its word, and nothing is drawn to find out.
        const size =
          page.width !== undefined && page.height !== undefined
            ? { width: page.width, height: page.height }
            : options.analyzeDimensions === true && isImageEntry(page.fileName)
              ? await imageSize(await book.readPage(index + 1))
              : { width: null, height: null }

        pages.push({
          fileName: page.fileName,
          mediaType: page.mediaType,
          width: size.width,
          height: size.height,
          size: page.size,
        })
      }

      return {
        status: 'READY',
        mediaType: book.mediaType,
        pages,
        files: book.files.map((file) => ({ fileName: file.fileName, size: file.size })),
        epubToc: book.epub?.toc ?? null,
        positions: book.epub ? computePositions(book.pages) : null,
        comment: remarks(book.epub),
      }
    } finally {
      book.close()
    }
  } catch (error) {
    // A reason the reference has a code for is the code and nothing else: the web
    // UI has the sentence. Anything else is its "unknown error", with the error's
    // own words, which are all there is to go on.
    if (error instanceof BookProblem) return failed(error.unsupported ? 'UNSUPPORTED' : 'ERROR', error.code)
    const file = fileProblem(error)
    if (file !== null) return failed('ERROR', file)

    const message = (error as Error).message
    if (message.includes('is not a book container')) {
      return failed('UNSUPPORTED', `${ANALYSIS_ERRORS.unsupported} ${message}`)
    }
    return failed('ERROR', `${ANALYSIS_ERRORS.unknown} ${message}`)
  }
}

/**
 * What is worth saying about a book that was read: parts of an EPUB that were
 * named and could not be found. The book is ready all the same.
 */
function remarks(epub: EpubInfo | undefined): string | null {
  if (!epub) return null
  const said: string[] = []
  if (epub.tocUnreadable) said.push(ANALYSIS_ERRORS.epubToc)
  if (epub.missingResources.length > 0) {
    said.push(`${ANALYSIS_ERRORS.missingResources} [${epub.missingResources.join(', ')}]`)
  }
  return said.length === 0 ? null : said.join(' ')
}
