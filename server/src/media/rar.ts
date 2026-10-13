import { createExtractorFromData } from 'node-unrar-js'

import { MAX_ENTRY_BYTES, type Container } from './zip.js'

/**
 * Open a RAR - what a CBR is.
 *
 * Unlike a zip, this cannot be read page by page from a random offset: the
 * library wants the whole archive in memory, which is what it gets.
 */
export async function openRar(buffer: Buffer): Promise<Container> {
  // The library wants an ArrayBuffer, and a Node Buffer may be a view into a
  // larger one, so the exact window is copied out.
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  const extractor = await createExtractorFromData({ data })
  const list = extractor.getFileList()
  const headers = [...list.fileHeaders].filter((header) => !header.flags.directory)

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
      // Asked for by name. The names are a list of strings: an entry that is not
      // found comes back as nothing at all, not as an error.
      const extracted = extractor.extract({ files: [name] })
      const file = [...extracted.files][0]
      if (!file || file.extraction === undefined) throw new Error(`cannot read ${name}`)
      return Buffer.from(file.extraction)
    },
    close: () => {
      // Nothing to release: the archive lives in the buffer we were handed.
    },
  }
}
