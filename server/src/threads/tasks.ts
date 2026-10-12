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

import { isMainThread, threadId } from 'node:worker_threads'

import { fileHash, koreaderHash, pageHash } from '../hashing/hashes.js'
import { openBook } from '../media/index.js'
import { inspectBook, type BookInspection } from '../media/inspect.js'
import { isbnBarcodePatch } from '../metadata/barcode.js'
import { readBookDocuments, type BookDocumentsRead } from '../metadata/document.js'
import { posterOf } from '../thumbnails/poster.js'

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

/** Which thread a task runs on, for telling whether the threads are really there. */
export async function whichThread(_input: Record<string, never> = {}): Promise<{ id: number; main: boolean }> {
  return { id: threadId, main: isMainThread }
}
