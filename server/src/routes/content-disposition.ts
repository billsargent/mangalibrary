/**
 * A `Content-Disposition` header for a file of any name.
 *
 * Node refuses a header value holding a character above U+00FF, so a book called
 * `進撃の巨人 v01.cbz` cannot have its name written into `filename="..."` as it is:
 * the response becomes a `500`. The header therefore carries the name twice, as
 * RFC 6266 describes - an ASCII stand-in for a client that reads nothing else, and
 * the real name percent-encoded in `filename*`, which every current browser and
 * HTTP library prefers.
 */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  return `${kind}; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${encodeExtended(fileName)}`
}

/** The name with everything a quoted string cannot carry replaced. */
function asciiFallback(fileName: string): string {
  return fileName.replace(/["\\]/g, "'").replace(/[^\x20-\x7e]/g, '_')
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * The name as an RFC 5987 `ext-value`.
 *
 * `encodeURIComponent` leaves `'`, `(`, `)` and `*` alone, and none of them is
 * allowed bare in an extended value - the apostrophe is its own delimiter. It also
 * throws on half of a surrogate pair, which a file name on disk is free to hold.
 */
function encodeExtended(fileName: string): string {
  return encodeURIComponent(fileName.replace(LONE_SURROGATE, '\uFFFD')).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
