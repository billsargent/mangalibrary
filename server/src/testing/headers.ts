/**
 * The file name a `Content-Disposition` header carries in its extended form
 * (`filename*=UTF-8''...`), decoded - the one a client shows the reader.
 */
export function extendedFileName(header: unknown): string {
  const encoded = String(header).split("filename*=UTF-8''")[1]
  if (encoded === undefined) throw new Error(`no extended file name in ${String(header)}`)
  return decodeURIComponent(encoded)
}
