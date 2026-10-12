import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  HASHED_PAGES_AT_EACH_END,
  KOREADER_OFFSETS,
  fileHash,
  hashBytes,
  koreaderHash,
  pageHash,
  pagesToHash,
} from './hashes.js'

/** A file on disk holding the bytes given, and its path. */
function fileOf(name: string, bytes: Buffer | string): string {
  const root = mkdtempSync(join(tmpdir(), 'ml-hashes-'))
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

/** A deterministic byte sequence that is not repetitive. */
function pseudorandom(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  let state = 12345
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    bytes[index] = state % 256
  }
  return bytes
}

describe('the hash of a file', () => {
  // The XXH3-128 hash of nothing at all is the one published value both this
  // implementation and the reference's algorithm agree on, so it is what pins the
  // digest's byte order. Komga ships no hash of its own to compare against.
  it('is XXH3-128, seeded with zero, in hex', async () => {
    expect(await hashBytes(Buffer.alloc(0))).toBe('99aa06d3014798d86001c324468d497f')
    expect(await fileHash(fileOf('empty.cbz', Buffer.alloc(0)))).toBe('99aa06d3014798d86001c324468d497f')
    expect(await fileHash(fileOf('abc.cbz', 'abc'))).toBe('06b05ab6733a618578af5f94892f3950')
  })

  it('is the same whether the file is read in one go or in chunks', async () => {
    const bytes = pseudorandom(300 * 1024)
    const path = fileOf('big.cbz', bytes)

    expect(await fileHash(path)).toBe(await hashBytes(bytes))
  })

  it('changes when a single byte changes', async () => {
    const bytes = pseudorandom(4096)
    const changed = Buffer.from(bytes)
    changed[100] = changed[100]! + 1

    expect(await fileHash(fileOf('a.cbz', bytes))).not.toBe(await fileHash(fileOf('b.cbz', changed)))
  })
})

describe('the hash of a page', () => {
  it('is the hash of the page as it is stored', async () => {
    const bytes = pseudorandom(2048)
    const changed = Buffer.from(bytes)
    changed[7] = changed[7]! + 1

    expect(await pageHash(bytes)).toBe(await hashBytes(bytes))
    expect(await pageHash(bytes)).not.toBe(await pageHash(changed))
  })
})

describe('the KOReader hash of a file', () => {
  it('samples the offsets the reference computes', () => {
    // The reference shifts a Long by a negative count for the first offset, which
    // Kotlin masks into a 62-bit shift and which overflows to zero. KOReader itself
    // would read from 256 bytes in; see `docs/COMPATIBILITY.md`.
    expect(KOREADER_OFFSETS).toEqual([
      0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824,
    ])
  })

  it('is the MD5 of a chunk the file is exactly the size of', async () => {
    const bytes = pseudorandom(1024)

    // Reading at 1024 is the end of the file, so only one chunk is hashed - which
    // makes the expected value the file's own MD5, computed without any of this.
    expect(await koreaderHash(fileOf('exact.cbz', bytes))).toBe(createHash('md5').update(bytes).digest('hex'))
  })

  it('hashes a short read as a full chunk, as the reference does', async () => {
    const bytes = pseudorandom(2000)
    const path = fileOf('short.cbz', bytes)

    // The two reads together are the whole file, and the reference hands the whole
    // buffer to the digest both times - so its value is the file's MD5 with the last
    // 48 bytes of the first chunk hashed a second time.
    const reused = Buffer.concat([bytes, bytes.subarray(976, 1024)])
    const asKoreaderWould = createHash('md5').update(bytes).digest('hex')

    expect(await koreaderHash(path)).toBe(createHash('md5').update(reused).digest('hex'))
    expect(await koreaderHash(path)).not.toBe(asKoreaderWould)
  })

  it('reads the same file the same way every time', async () => {
    const path = fileOf('again.cbz', pseudorandom(5000))

    expect(await koreaderHash(path)).toBe(await koreaderHash(path))
  })
})

describe('the pages of a book that are hashed', () => {
  it('are the first and last few', () => {
    expect(HASHED_PAGES_AT_EACH_END).toBe(3)
    expect(pagesToHash(10)).toEqual([1, 2, 3, 8, 9, 10])
    expect(pagesToHash(7)).toEqual([1, 2, 3, 5, 6, 7])
  })

  it('are all of them when a book has fewer than that', () => {
    expect(pagesToHash(4)).toEqual([1, 2, 3, 4])
    expect(pagesToHash(6)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('are none of them when a book has no pages', () => {
    expect(pagesToHash(0)).toEqual([])
  })
})
