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
 * The most one entry may unpack to.
 *
 * An entry is handed over whole, so its size is memory. No page or resource of a
 * real book comes near this, and an archive that claims more is refused rather
 * than believed.
 */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024

export interface ZipOptions {
  /** A lower limit than {@link MAX_ENTRY_BYTES}, which the tests use. */
  maxEntryBytes?: number
}

/**
 * Open a ZIP - which is what a CBZ and an EPUB both are.
 *
 * Given a path, the archive stays on disk: opening it reads the list of entries
 * at its end, and reading an entry reads that entry's bytes and no others. A book
 * of a gigabyte costs the page that was asked for, not the gigabyte, which is what
 * lets a large library be scanned and read without the memory to hold its books.
 * The file is held open until `close`.
 *
 * Bytes already in memory are read where they are.
 */
export function openZip(source: string | Buffer, options: ZipOptions = {}): Promise<Container> {
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES

  return new Promise((resolve, reject) => {
    // The archive is closed by whoever opened it, not when its list has been
    // read: entries are read long after that.
    const settings = { lazyEntries: true, autoClose: false }

    const opened = (error: Error | null, zipfile?: yauzl.ZipFile): void => {
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
          read: (name) => readEntry(zipfile, byName.get(name), name, maxEntryBytes),
          close: () => zipfile.close(),
        }),
      )

      zipfile.on('error', (failure: Error) => {
        // Nobody holds an archive that could not be listed, so nobody would close it.
        zipfile.close()
        reject(failure)
      })
      zipfile.readEntry()
    }

    if (typeof source === 'string') yauzl.open(source, settings, opened)
    else yauzl.fromBuffer(source, settings, opened)
  })
}

function readEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  name: string,
  maxEntryBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!entry) {
      reject(new Error(`no entry named ${name}`))
      return
    }
    // The size an entry declares is the size it is held to: the stream fails if
    // the data runs past it, so checking the declaration is checking the data.
    if (entry.uncompressedSize > maxEntryBytes) {
      reject(new Error(`${name} is too large to read: ${entry.uncompressedSize} bytes`))
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
