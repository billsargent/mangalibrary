import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

/**
 * Write a ZIP without holding it in memory.
 *
 * A series or read list download can be far larger than the server would want to
 * buffer, so the archive is produced as it is sent: each entry is written with a
 * data descriptor, which lets the checksum and the size follow the data instead
 * of being known up front. Entries are stored rather than compressed, because a
 * book file is already compressed - the reference does the same, setting its
 * deflate level to no compression.
 *
 * Zip64 is always on, as it is in the reference: an archive of a large series
 * passes the 4 GiB limit of the original format, and writing the zip64 structures
 * unconditionally means the same code path is exercised by every archive.
 */

export interface ZipEntry {
  /** Name of the entry inside the archive. */
  name: string
  /** The file whose bytes become the entry, when it is on disk. */
  path?: string
  /** The bytes themselves, when the entry comes from inside another archive. */
  bytes?: Buffer
  /**
   * Where to get the bytes when it is this entry's turn to be written. An archive
   * rewritten from another holds one entry in memory at a time this way, not all
   * of them.
   */
  read?: () => Promise<Buffer>
}

const LOCAL_HEADER = 0x04034b50
const DATA_DESCRIPTOR = 0x08074b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50

/** Version 4.5, the first that understands the zip64 structures below. */
const VERSION = 45
/** General purpose flags: bit 3 (data descriptor follows) and bit 11 (UTF-8 names). */
const FLAGS = 0x0808
/** Method 0: stored, no compression. */
const STORED = 0
const ZIP64 = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/** CRC-32, fed a chunk at a time so a file is never buffered to checksum it. */
class Crc32 {
  private value = -1

  update(buffer: Buffer): void {
    let crc = this.value
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    this.value = crc
  }

  digest(): number {
    return (this.value ^ -1) >>> 0
  }
}

/** The zip64 extra field, carrying only the values that do not fit in 32 bits. */
function zip64Extra(size: number, offset: number): Buffer {
  const values: bigint[] = []
  if (size >= ZIP64) values.push(BigInt(size))
  if (size >= ZIP64) values.push(BigInt(size))
  if (offset >= ZIP64) values.push(BigInt(offset))
  if (values.length === 0) return Buffer.alloc(0)

  const extra = Buffer.alloc(4 + values.length * 8)
  extra.writeUInt16LE(0x0001, 0)
  extra.writeUInt16LE(values.length * 8, 2)
  values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8))
  return extra
}

function localHeader(name: Buffer): Buffer {
  // The sizes are unknown until the file has been read, so they are marked as
  // carried by the data descriptor; the zip64 field says how wide it will be.
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(0x0001, 0)
  extra.writeUInt16LE(16, 2)
  extra.writeBigUInt64LE(0n, 4)
  extra.writeBigUInt64LE(0n, 12)

  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_HEADER, 0)
  header.writeUInt16LE(VERSION, 4)
  header.writeUInt16LE(FLAGS, 6)
  header.writeUInt16LE(STORED, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(ZIP64, 18)
  header.writeUInt32LE(ZIP64, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, name, extra])
}

function dataDescriptor(crc: number, size: number): Buffer {
  const descriptor = Buffer.alloc(24)
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0)
  descriptor.writeUInt32LE(crc, 4)
  descriptor.writeBigUInt64LE(BigInt(size), 8)
  descriptor.writeBigUInt64LE(BigInt(size), 16)
  return descriptor
}

function centralHeader(name: Buffer, crc: number, size: number, offset: number): Buffer {
  const extra = zip64Extra(size, offset)
  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_HEADER, 0)
  header.writeUInt16LE(VERSION, 4)
  header.writeUInt16LE(VERSION, 6)
  header.writeUInt16LE(FLAGS, 8)
  header.writeUInt16LE(STORED, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0, 14)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(size >= ZIP64 ? ZIP64 : size, 20)
  header.writeUInt32LE(size >= ZIP64 ? ZIP64 : size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(offset >= ZIP64 ? ZIP64 : offset, 42)
  return Buffer.concat([header, name, extra])
}

function endOfCentralDirectory(entries: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(56)
  end.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY, 0)
  end.writeBigUInt64LE(44n, 4)
  end.writeUInt16LE(VERSION, 12)
  end.writeUInt16LE(VERSION, 14)
  end.writeUInt32LE(0, 16)
  end.writeUInt32LE(0, 20)
  end.writeBigUInt64LE(BigInt(entries), 24)
  end.writeBigUInt64LE(BigInt(entries), 32)
  end.writeBigUInt64LE(BigInt(size), 40)
  end.writeBigUInt64LE(BigInt(offset), 48)
  return end
}

function endOfCentralDirectoryLocator(offset: number): Buffer {
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(offset), 8)
  locator.writeUInt32LE(1, 16)
  return locator
}

function trailer(entries: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Math.min(entries, 0xffff), 8)
  end.writeUInt16LE(Math.min(entries, 0xffff), 10)
  end.writeUInt32LE(size >= ZIP64 ? ZIP64 : size, 12)
  end.writeUInt32LE(offset >= ZIP64 ? ZIP64 : offset, 16)
  end.writeUInt16LE(0, 20)
  return end
}

async function* write(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const directory: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const header = localHeader(name)
    const start = offset
    yield header
    offset += header.length

    const crc = new Crc32()
    let size = 0
    if (entry.path === undefined) {
      const buffer = entry.bytes ?? (await entry.read?.()) ?? Buffer.alloc(0)
      crc.update(buffer)
      size = buffer.length
      yield buffer
    } else {
      for await (const chunk of createReadStream(entry.path)) {
        const buffer = chunk as Buffer
        crc.update(buffer)
        size += buffer.length
        yield buffer
      }
    }
    offset += size

    const descriptor = dataDescriptor(crc.digest(), size)
    yield descriptor
    offset += descriptor.length

    directory.push(centralHeader(name, crc.digest(), size, start))
  }

  const contents = Buffer.concat(directory)
  const contentsOffset = offset
  yield contents
  yield endOfCentralDirectory(entries.length, contents.length, contentsOffset)
  yield endOfCentralDirectoryLocator(contentsOffset + contents.length)
  yield trailer(entries.length, contents.length, contentsOffset)
}

/** A ZIP of the given files, readable as a stream. */
export function zipStream(entries: ZipEntry[]): Readable {
  return Readable.from(write(entries))
}
