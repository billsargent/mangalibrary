/**
 * Hashing a book's file and its pages, the way Komga does it.
 *
 * Two hashes are kept per book. The file hash identifies the file itself, and is what
 * lets a book be recognised again after it moves or is renamed. The page hashes
 * identify the images inside it, so that the same scan arriving twice - in two books,
 * or in the same book after a re-download - can be found and dealt with.
 *
 * Both use XXH3-128 seeded with zero, written as thirty-two lower-case hex
 * characters, which is what the reference's hasher produces and what a database
 * carried over from it holds.
 *
 * Deliberate differences from the reference are noted where they happen: the
 * reference re-encodes a JPEG page before hashing it, and its KOReader hash has two
 * artefacts of the way it reads the file. See `docs/COMPATIBILITY.md`.
 */

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createXXHash128 } from 'hash-wasm'

/** How many pages at each end of a book are hashed, as the reference hashes them. */
export const HASHED_PAGES_AT_EACH_END = 3

/** The chunk size used to read a file, matching the reference's buffer. */
const CHUNK_BYTES = 64 * 1024

/** The buffer the KOReader hash reads into, one page-sized read after another. */
const KOREADER_BUFFER_BYTES = 1024

/**
 * The offsets the KOReader hash samples.
 *
 * KOReader walks `1024 << (2 * i)` for `i` from -1 to 10. The reference shifts a
 * `Long` by a *negative* count, which Kotlin masks into a 62-bit shift and which
 * overflows to zero - so its first read is at the start of the file. KOReader itself
 * shifts by -2, which is a right shift, and reads from 256 bytes in. This mirrors the
 * reference, because a database carried over from it holds hashes computed that way;
 * it is recorded in `docs/COMPATIBILITY.md`.
 */
export const KOREADER_OFFSETS = [0, ...[...Array(11).keys()].map((i) => 1024 * 2 ** (2 * i))]

/** The XXH3-128 hash of some bytes, as thirty-two hex characters. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const hasher = await createXXHash128(0)
  hasher.init()
  hasher.update(bytes)
  return hasher.digest('hex')
}

/** The XXH3-128 hash of a whole file, read in chunks so a large book is not loaded. */
export async function fileHash(path: string): Promise<string> {
  const hasher = await createXXHash128(0)
  hasher.init()

  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
    hasher.update(chunk as Uint8Array)
  }
  return hasher.digest('hex')
}

/**
 * The hash of a page.
 *
 * The page's bytes are hashed as they are stored. The reference re-encodes a JPEG
 * first, to strip the EXIF metadata that makes two copies of one page differ - but
 * Java's encoder and sharp's cannot produce the same bytes, so re-encoding here would
 * cost time and buy no compatibility with it. Two copies of one page that differ only
 * in metadata therefore hash differently here; `docs/COMPATIBILITY.md` records it.
 */
export async function pageHash(bytes: Uint8Array): Promise<string> {
  return await hashBytes(bytes)
}

/**
 * The KOReader hash of a file: a partial MD5 over eleven sampled chunks.
 *
 * The buffer is read into and reused, and a short read still updates the digest with
 * the whole buffer, so the tail of a previous read is hashed again. That is the
 * reference's behaviour - KOReader's own implementation hashes only the bytes it read
 * - and replicating it is what keeps a migrated database's values comparable.
 */
export async function koreaderHash(path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const digest = createHash('md5')
  const buffer = Buffer.alloc(KOREADER_BUFFER_BYTES)

  const file = await open(path, 'r')
  try {
    for (const offset of KOREADER_OFFSETS) {
      const read = await file.read(buffer, 0, KOREADER_BUFFER_BYTES, offset)
      if (read.bytesRead > 0) digest.update(buffer)
    }
  } finally {
    await file.close()
  }

  return digest.digest('hex')
}

/**
 * The pages of a book that are hashed: the first few and the last few.
 *
 * A duplicate is a whole book, so its first and last pages are enough to recognise it
 * - which is what keeps hashing a library quick. Numbers are one-based.
 */
export function pagesToHash(pageCount: number, atEachEnd = HASHED_PAGES_AT_EACH_END): number[] {
  const pages: number[] = []
  for (let number = 1; number <= pageCount; number += 1) {
    if (number <= atEachEnd || number > pageCount - atEachEnd) pages.push(number)
  }
  return pages
}
