/**
 * The work that is done on a worker thread: everything that reads a book's file.
 *
 * Unpacking a RAR, rendering a PDF and hashing a file are computation, and
 * computation on the main thread is a server that answers nobody until it is
 * done. Each task here takes a path and gives back plain data; none touches the
 * database, which stays with the thread that owns it.
 *
 * This file is the worker's entry point, and also what runs in place when there
 * are no threads, so the two cannot drift apart.
 */

import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { isMainThread, threadId } from 'node:worker_threads'
import Piscina from 'piscina'

import { fileHash, koreaderHash, pageHash } from '../hashing/hashes.js'
import { openBook } from '../media/index.js'
import { keptOpen } from '../media/kept-open.js'
import { inspectBook, type BookInspection } from '../media/inspect.js'
import { isbnBarcodePatch } from '../metadata/barcode.js'
import { readBookDocuments, type BookDocumentsRead } from '../metadata/document.js'
import { posterOf } from '../thumbnails/poster.js'
import { zipStream } from '../zip.js'
import { packPage } from './page-bytes.js'

/** Describe what is inside a book. Never throws for a bad file. */
export async function inspect(input: {
  path: string
  options?: { analyzeDimensions?: boolean }
}): Promise<BookInspection> {
  return inspectBook(input.path, input.options)
}

/** Read the metadata documents a book carries. Never throws for a bad file. */
export async function documents(input: { path: string }): Promise<BookDocumentsRead> {
  return readBookDocuments(input.path)
}

/**
 * The ISBN on a barcode printed on one of a book's pages, or null.
 *
 * Finding a barcode is looking at every pixel of several pages, which is the most
 * computation analysing a book asks for.
 */
export async function barcode(input: { path: string }): Promise<{ isbn: string } | null> {
  const patch = await isbnBarcodePatch(input.path)
  return patch?.isbn === undefined ? null : { isbn: patch.isbn }
}

/** The hash of a whole file. */
export async function hashFile(input: { path: string }): Promise<string> {
  return fileHash(input.path)
}

/** The hash KOReader knows a file by. */
export async function hashKoreader(input: { path: string }): Promise<string> {
  return koreaderHash(input.path)
}

/** The hashes of some pages of a book, in the order they were asked for. */
export async function hashPages(input: { path: string; pages: number[] }): Promise<{ number: number; hash: string }[]> {
  const book = await openBook(input.path)
  try {
    const hashes: { number: number; hash: string }[] = []
    for (const number of input.pages) hashes.push({ number, hash: await pageHash(await book.readPage(number)) })
    return hashes
  } finally {
    book.close()
  }
}

/**
 * The image a book's poster is made from, or null when it has none.
 *
 * The bytes cross between threads as a plain array of bytes, which is what a
 * buffer becomes on the way; the caller makes a buffer of them again.
 */
export async function poster(input: { path: string }): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  return posterOf(input.path)
}

/**
 * One page of a book that has to be unpacked or drawn: a CBR's or a PDF's.
 *
 * The book stays open on this thread for the next page of it. A file that will
 * not open and a page that is not there are answers, not errors: the caller
 * tells a reader which it was.
 */
export async function readPage(input: {
  path: string
  pageNumber: number
}): Promise<ArrayBuffer | { failed: 'OPEN' | 'PAGE' }> {
  let book
  try {
    book = await keptOpen(input.path)
  } catch {
    return { failed: 'OPEN' }
  }
  const page = book.pages[input.pageNumber - 1]
  if (page === undefined) return { failed: 'PAGE' }
  let packed: ArrayBuffer
  try {
    packed = packPage(await book.readPage(input.pageNumber), page.mediaType)
  } catch {
    return { failed: 'PAGE' }
  }
  // Moved to the main thread rather than copied there (see `page-bytes.ts`). Run in
  // place, with no threads, there is nothing to move it from.
  return isMainThread ? packed : (Piscina.move(packed) as unknown as ArrayBuffer)
}

/**
 * Write the named entries of a book into a new ZIP, and say whether the ZIP then
 * holds every one of them.
 *
 * Entries go across one at a time, so a book of any size costs the memory of its
 * largest page. The answer comes from opening what was written, not from having
 * written it without an error: the file about to replace a book has to be shown
 * to be one. Throws nothing; a failure is `ok: false`, and the caller removes
 * whatever was left behind.
 */
export async function convertToZip(input: {
  source: string
  target: string
  names: string[]
}): Promise<{ ok: boolean }> {
  try {
    const book = await openBook(input.source)
    try {
      const pageNumbers = new Map(book.pages.map((page, index) => [page.fileName, index + 1]))
      const entries = input.names.map((name) => ({
        name,
        read: () => {
          const pageNumber = pageNumbers.get(name)
          return pageNumber === undefined ? book.readResource(name) : book.readPage(pageNumber)
        },
      }))
      await pipeline(zipStream(entries), createWriteStream(input.target))
    } finally {
      book.close()
    }

    const written = await openBook(input.target, 'ZIP')
    try {
      const holds = new Set([
        ...written.pages.map((page) => page.fileName),
        ...written.files.map((file) => file.fileName),
      ])
      return { ok: input.names.every((name) => holds.has(name)) }
    } finally {
      written.close()
    }
  } catch {
    return { ok: false }
  }
}

/** One page of a PDF as a PDF of its own, from the book kept open on this thread. */
export async function readPageRaw(input: {
  path: string
  pageNumber: number
}): Promise<{ bytes: Uint8Array } | { failed: 'OPEN' | 'PAGE' | 'UNSUPPORTED' }> {
  let book
  try {
    book = await keptOpen(input.path)
  } catch {
    return { failed: 'OPEN' }
  }
  if (book.readPageRaw === undefined) return { failed: 'UNSUPPORTED' }
  try {
    return { bytes: await book.readPageRaw(input.pageNumber) }
  } catch {
    return { failed: 'PAGE' }
  }
}

/** Which thread a task runs on, for telling whether the threads are really there. */
export async function whichThread(_input: Record<string, never> = {}): Promise<{ id: number; main: boolean }> {
  return { id: threadId, main: isMainThread }
}
