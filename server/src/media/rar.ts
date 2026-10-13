import { createExtractorFromData, createExtractorFromFile } from 'node-unrar-js'

import { ANALYSIS_ERRORS, BookProblem } from './problems.js'
import { MAX_ENTRY_BYTES, type Container } from './zip.js'

/** The part of the library's extractor this file reaches into. */
interface ExtractorInternals {
  /** The compiled unpacker, one per thread, which calls back into `extractor`. */
  unrar: { extractor: unknown; HEAPU8: Uint8Array }
  /** Called when the unpacker starts writing an entry. Returns a handle. */
  create(filename: string): number
  write(handle: number, pointer: number, size: number): boolean
  closeFile(handle: number): void
  /** What the in-memory extractor has unpacked so far, which it never lets go of. */
  dataFiles?: Record<string, unknown>
}

type Extractor = Awaited<ReturnType<typeof createExtractorFromData>>

/**
 * Open a RAR - what a CBR is.
 *
 * Given a path, the archive stays on disk: opening it reads its headers, and
 * reading an entry reads what that entry needs. The library's own way of reading
 * from disk also writes what it unpacks to disk, which is no use to a server
 * that wants one page in memory; so the unpacked bytes are caught on their way
 * out instead, and the archive is still read from the file.
 *
 * Bytes already in memory are read where they are.
 */
export async function openRar(source: string | Buffer): Promise<Container> {
  const fromDisk = typeof source === 'string'
  const extractor = fromDisk
    ? ((await createExtractorFromFile({ filepath: source })) as unknown as Extractor)
    : await createExtractorFromData({
        // The library wants an ArrayBuffer, and a Node Buffer may be a view into a
        // larger one, so the exact window is copied out.
        data: source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer,
      })
  const internals = extractor as unknown as ExtractorInternals

  // What is being unpacked, when it is being caught rather than written to disk.
  // The handle is ours: the ones the library hands out are the system's file
  // handles, which are small numbers. It has to be positive, because it travels
  // through the unpacker as an unsigned number.
  let caught: Buffer[] | null = null
  const CAUGHT = 0x7ffffff0
  if (fromDisk) {
    const { write, closeFile } = internals
    internals.create = () => {
      caught = []
      return CAUGHT
    }
    internals.write = (handle, pointer, size) => {
      if (handle !== CAUGHT) return write.call(internals, handle, pointer, size)
      // Copied: the unpacker reuses the memory this points into.
      caught?.push(Buffer.from(internals.unrar.HEAPU8.subarray(pointer, pointer + size)))
      return true
    }
    internals.closeFile = (handle) => {
      if (handle !== CAUGHT) closeFile.call(internals, handle)
    }
  }

  /**
   * The unpacker belongs to the thread and calls back into whichever archive
   * was opened last. Two archives open at once - which the main thread can have -
   * would answer each other's calls, so each use says whose turn it is.
   */
  const takeTurn = (): void => {
    internals.unrar.extractor = extractor
  }

  takeTurn()
  // Two kinds of RAR are not read, as the reference does not read them: one that
  // needs a password, and one that is a part of a set. An archive whose very list
  // of files is encrypted cannot be listed, which is the same answer.
  const encrypted = (): BookProblem =>
    new BookProblem('Encrypted RAR archives are not supported', ANALYSIS_ERRORS.encryptedRar, true)
  let list
  let all
  try {
    list = extractor.getFileList()
    all = [...list.fileHeaders]
  } catch (error) {
    if (/PASSWORD/i.test(String((error as { reason?: unknown }).reason ?? (error as Error).message))) throw encrypted()
    throw error
  }
  if (list.arcHeader.flags.volume) {
    throw new BookProblem('Multi-Volume RAR archives are not supported', ANALYSIS_ERRORS.multiVolumeRar, true)
  }
  if (list.arcHeader.flags.headerEncrypted || all.some((header) => header.flags.encrypted)) throw encrypted()
  const headers = all.filter((header) => !header.flags.directory)

  const sizes = new Map<string, number>()
  for (const header of headers) sizes.set(header.name, header.unpSize)

  return {
    entries: headers.map((header) => header.name),
    sizes,
    read: async (name) => {
      // The same limit a zip entry is held to: what is unpacked is held whole.
      const size = sizes.get(name)
      if (size !== undefined && size > MAX_ENTRY_BYTES) {
        throw new Error(`${name} is too large to read: ${size} bytes`)
      }

      takeTurn()
      caught = null
      try {
        // Asked for by name. The names are a list of strings: an entry that is not
        // found comes back as nothing at all, not as an error.
        const extracted = extractor.extract({ files: [name] })
        const file = [...extracted.files][0]
        if (!file) throw new Error(`cannot read ${name}`)

        if (fromDisk) {
          // An empty entry is never written, so nothing was caught for it.
          return Buffer.concat(caught ?? [])
        }
        if (file.extraction === undefined) throw new Error(`cannot read ${name}`)
        return Buffer.from(file.extraction)
      } finally {
        caught = null
        // The in-memory extractor keeps every entry it has unpacked. An archive
        // that stays open while a book is read would grow by each page turned.
        if (internals.dataFiles) {
          for (const key of Object.keys(internals.dataFiles)) {
            if (key.startsWith('*Extracted*/')) delete internals.dataFiles[key]
          }
        }
      }
    },
    close: () => {
      // Nothing to release: the file is opened for each read and closed after it.
    },
  }
}
