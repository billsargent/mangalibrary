/**
 * A page's bytes and media type in one buffer, so a reader thread can hand a page to
 * the main thread instead of copying it there.
 *
 * Whatever a thread returns is copied into the main thread, and copying is work the
 * main thread does: a 20 MB page held up every other request for 72 ms (#162). A
 * buffer can instead be transferred - moved, at no cost - but only as the whole
 * result. So the page goes as one buffer: the media type's length in the first byte,
 * the media type, then the page.
 */

/** Pack a page into a buffer of its own, which can be transferred. */
export function packPage(bytes: Uint8Array, mediaType: string): ArrayBuffer {
  const type = Buffer.from(mediaType, 'utf8')
  if (type.length > 255) throw new Error('media type too long')
  // A buffer of its own: what a book hands back may be a view into memory it keeps,
  // which must not be moved out from under it.
  const packed = new Uint8Array(1 + type.length + bytes.byteLength)
  packed[0] = type.length
  packed.set(type, 1)
  packed.set(bytes, 1 + type.length)
  return packed.buffer
}

/** The page and its media type, without copying the page. */
export function unpackPage(packed: ArrayBuffer): { bytes: Buffer; mediaType: string } {
  const view = new Uint8Array(packed)
  const typeLength = view[0] ?? 0
  return {
    mediaType: Buffer.from(packed, 1, typeLength).toString('utf8'),
    bytes: Buffer.from(packed, 1 + typeLength),
  }
}
