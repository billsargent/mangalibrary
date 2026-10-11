import yauzl from 'yauzl'

/** An archive whose entries can be listed and read, and which must be closed. */
export interface Container {
  /** Entry names, in the order the archive lists them. */
  entries: string[]
  sizes: Map<string, number>
  read(name: string): Promise<Buffer>
  close(): void
}

/**
 * Open a ZIP - which is what a CBZ and an EPUB both are.
 *
 * The file is held in memory. Book files are read whole by every reader in this
 * project anyway (the pages have to be decoded), and streaming a zip from disk
 * would buy complexity rather than throughput; the scanner bounds how many books
 * are open at once instead.
 */
export function openZip(buffer: Buffer): Promise<Container> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('not a zip archive'))
        return
      }

      const byName = new Map<string, yauzl.Entry>()
      const entries: string[] = []
      const sizes = new Map<string, number>()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        // Directory entries carry no data and are not resources.
        if (!entry.fileName.endsWith('/')) {
          byName.set(entry.fileName, entry)
          entries.push(entry.fileName)
          sizes.set(entry.fileName, entry.uncompressedSize)
        }
        zipfile.readEntry()
      })

      zipfile.on('end', () =>
        resolve({
          entries,
          sizes,
          read: (name) => readEntry(zipfile, byName.get(name), name),
          close: () => zipfile.close(),
        }),
      )

      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

function readEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry | undefined, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!entry) {
      reject(new Error(`no entry named ${name}`))
      return
    }

    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`cannot read ${name}`))
        return
      }

      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}
