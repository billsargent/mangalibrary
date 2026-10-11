/**
 * The containers a book can be in.
 *
 * These are the four the reference accepts and can represent. An archive format
 * it has no media type for (7z, tar) is not "supported but untested" here - it is
 * not accepted at all, and a file in one of those formats is analysed as
 * unsupported rather than quietly treated as a book nobody can read.
 */
export type ContainerKind = 'ZIP' | 'RAR' | 'EPUB' | 'PDF'

export const MEDIA_TYPES: Record<ContainerKind, string> = {
  ZIP: 'application/zip',
  RAR: 'application/x-rar-compressed',
  EPUB: 'application/epub+zip',
  PDF: 'application/pdf',
}

const BY_EXTENSION: Record<string, ContainerKind> = {
  cbz: 'ZIP',
  zip: 'ZIP',
  cbr: 'RAR',
  rar: 'RAR',
  epub: 'EPUB',
  pdf: 'PDF',
}

/** The container a file name refers to, or `null` when it is none of them. */
export function containerFor(fileName: string): ContainerKind | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXTENSION[extension] ?? null
}

/**
 * The reading profile of an analysed book, from its recorded media type.
 *
 * A ZIP or RAR of images is what the reference calls the Divina profile, and it
 * is served the same way as a PDF: one page at a time. `null` means the media
 * type is not one this server can read, which is what analysis left behind for a
 * book it could not open.
 */
export function profileFor(mediaType: string | null): 'DIVINA' | 'PDF' | 'EPUB' | null {
  switch (mediaType) {
    case 'application/zip':
    case 'application/x-rar-compressed':
      return 'DIVINA'
    case 'application/pdf':
      return 'PDF'
    case 'application/epub+zip':
      return 'EPUB'
    default:
      return null
  }
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jxl: 'image/jxl',
  xhtml: 'application/xhtml+xml',
  html: 'application/xhtml+xml',
  htm: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  svg: 'image/svg+xml',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  xml: 'application/xml',
  nc: 'application/x-dtbncx+xml',
}

/** The media type of a file inside a container, by extension. */
export function mediaTypeFor(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export function isImageEntry(fileName: string): boolean {
  return mediaTypeFor(fileName).startsWith('image/')
}

/**
 * Order pages the way a reader expects.
 *
 * Plain sorting puts `10.jpg` before `9.jpg`, which is how a book ends up out of
 * order, so runs of digits are compared as numbers and everything else as text.
 */
export function naturalCompare(left: string, right: string): number {
  const split = (value: string): string[] => value.match(/\d+|\D+/g) ?? []
  const a = split(left)
  const b = split(right)

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index]
    const rightPart = b[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue

    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) {
      const difference = Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10)
      if (difference !== 0) return difference
      continue
    }

    const folded = leftPart.toLowerCase().localeCompare(rightPart.toLowerCase())
    if (folded !== 0) return folded
    return leftPart < rightPart ? -1 : 1
  }

  return 0
}
