/**
 * Why a book could not be analysed, in the reference's codes.
 *
 * The reference puts a code in `media.comment` and the web UI has a sentence for
 * each, so a book that fails here for the reason it would fail there says so the
 * same way. A reason only this server has is `ERR_1005`, the reference's "unknown
 * error", with the error's own words after it.
 */
export const ANALYSIS_ERRORS = {
  /** The file is there and may not be read. */
  unreadable: 'ERR_1000',
  /** Not a kind of file this server reads. */
  unsupported: 'ERR_1001',
  encryptedRar: 'ERR_1002',
  multiVolumeRar: 'ERR_1004',
  unknown: 'ERR_1005',
  /** An archive with nothing in it that is a page. */
  noPages: 'ERR_1006',
  /** The file is not there. */
  notFound: 'ERR_1018',
  /** Named `.epub`, and not one. */
  notAnEpub: 'ERR_1032',
  /** An EPUB whose manifest names resources the file does not hold. Not a failure. */
  missingResources: 'ERR_1033',
  /** An EPUB whose table of contents is named and could not be read. Not a failure. */
  epubToc: 'ERR_1035',
} as const

/** A book that cannot be analysed, for a reason the reference has a code for. */
export class BookProblem extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Whether the book is of a kind that is not read at all, as opposed to one that is broken. */
    readonly unsupported = false,
  ) {
    super(message)
  }
}

/** The code a filesystem error is reported with, or null when it is not one of those. */
export function fileProblem(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return ANALYSIS_ERRORS.notFound
  if (code === 'EACCES' || code === 'EPERM') return ANALYSIS_ERRORS.unreadable
  return null
}
