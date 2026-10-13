import { crc32 } from 'node:zlib'

/**
 * Write a RAR archive, for tests.
 *
 * RAR is a format only its owner's tools may compress into, and none is to hand.
 * But an archive does not have to compress: the version 4 format can hold files
 * as they are ("stored"), and that much of it is a few fixed-size headers. This
 * writes exactly that - enough to hand the reader a real archive of whatever a
 * test needs, a comic's pages included, at any size.
 *
 * Not for anything but tests: names are ASCII only, nothing is compressed, and
 * there are no folders, comments or recovery records.
 */
export function writeRar(entries: readonly { name: string; data: Buffer }[]): Buffer {
  /** A header's checksum is the low half of the CRC of everything after it. */
  const withChecksum = (afterChecksum: Buffer): Buffer => {
    const checksum = Buffer.alloc(2)
    checksum.writeUInt16LE(crc32(afterChecksum) & 0xffff)
    return Buffer.concat([checksum, afterChecksum])
  }

  const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

  const main = Buffer.alloc(11)
  main.writeUInt8(0x73, 0) // an archive header
  main.writeUInt16LE(0, 1) // no flags
  main.writeUInt16LE(13, 3) // its size, checksum included

  const blocks: Buffer[] = [marker, withChecksum(main)]
  for (const entry of entries) {
    if (!/^[\x20-\x7e]+$/.test(entry.name)) throw new Error(`a test archive takes ASCII names only: ${entry.name}`)
    // Inside an archive a path is written with backslashes.
    const name = Buffer.from(entry.name.replaceAll('/', '\\'), 'latin1')

    const header = Buffer.alloc(30 + name.length)
    header.writeUInt8(0x74, 0) // a file header
    header.writeUInt16LE(0x8000, 1) // the data follows, and its size is in the header
    header.writeUInt16LE(32 + name.length, 3) // the header's size, checksum included
    header.writeUInt32LE(entry.data.length, 5) // packed size
    header.writeUInt32LE(entry.data.length, 9) // unpacked size: the same, nothing is compressed
    header.writeUInt8(2, 13) // made on Windows
    header.writeUInt32LE(crc32(entry.data), 14)
    header.writeUInt32LE(0x5a210000, 18) // a date: 2025-01-01
    header.writeUInt8(20, 22) // the version needed to unpack
    header.writeUInt8(0x30, 23) // stored
    header.writeUInt16LE(name.length, 24)
    header.writeUInt32LE(0x20, 26) // an ordinary file
    name.copy(header, 30)

    blocks.push(withChecksum(header), entry.data)
  }

  const end = Buffer.alloc(5)
  end.writeUInt8(0x7b, 0) // the end of the archive
  end.writeUInt16LE(0x4000, 1)
  end.writeUInt16LE(7, 3)
  blocks.push(withChecksum(end))

  return Buffer.concat(blocks)
}
