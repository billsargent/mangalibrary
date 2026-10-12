/**
 * Making the images the UI is made of.
 *
 * A thumbnail is a JPEG, as the reference produces, fitted inside a square without
 * being enlarged, and a mosaic is four of them laid out two by two on a canvas the
 * shape of a cover. Both are here rather than in the routes because the worker
 * needs them too - a poster is generated in the background - and because the page
 * thumbnail endpoint wants exactly the same resizing.
 */

import sharp from 'sharp'

/** The sizes a server can be set to, as the reference names them. */
export const THUMBNAIL_SIZES: Record<string, number> = {
  DEFAULT: 300,
  MEDIUM: 600,
  LARGE: 900,
  XLARGE: 1200,
}

/**
 * How wide a mosaic is for its height.
 *
 * It is the shape of a cover, which is what makes four of them fit a screen the way
 * one does.
 */
export const MOSAIC_RATIO = 0.7066666667

/** The largest of the four sizes, in pixels. */
export const DEFAULT_THUMBNAIL_SIZE = THUMBNAIL_SIZES.DEFAULT ?? 300

/** An image, its bytes and the size it ended up. */
export interface RenderedImage {
  bytes: Buffer
  width: number
  height: number
  mediaType: string
}

/** The pixels a size name means, falling back to the smallest. */
export function maxEdgeFor(setting: string | null | undefined): number {
  return THUMBNAIL_SIZES[setting ?? ''] ?? DEFAULT_THUMBNAIL_SIZE
}

/**
 * Shrink an image to fit inside a square, without enlarging it.
 *
 * A JPEG that already fits is kept as it is, as the reference keeps it, which is
 * what stops a poster from being re-encoded every time it is asked for. Null means
 * the bytes are not an image, or not one this server can read.
 */
export async function resizedImage(bytes: Buffer, mediaType: string, size: number): Promise<RenderedImage | null> {
  try {
    const metadata = await sharp(bytes).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    const longest = Math.max(width, height)

    if (mediaType === 'image/jpeg' && longest > 0 && longest <= size) {
      return { bytes, width, height, mediaType: 'image/jpeg' }
    }

    const target = Math.min(longest > 0 ? longest : size, size)
    const rendered = await sharp(bytes)
      .resize(target, target, { fit: 'inside' })
      .jpeg()
      .toBuffer({ resolveWithObject: true })
    return { bytes: rendered.data, width: rendered.info.width, height: rendered.info.height, mediaType: 'image/jpeg' }
  } catch {
    return null
  }
}

/**
 * Lay images out two by two on a cover-shaped canvas.
 *
 * Each one is fitted into a quarter, as the reference fits it. The canvas is black
 * underneath, also as the reference leaves it, which is what shows through where a
 * tile does not reach. No images at all gives nothing to show, which a caller
 * answers with a 404.
 */
export async function mosaic(images: readonly Buffer[], maxEdge: number): Promise<RenderedImage | null> {
  const usable = images.slice(0, 4)
  if (usable.length === 0) return null

  const width = Math.round(maxEdge * MOSAIC_RATIO)
  const quadrantWidth = Math.round(width / 2)
  const quadrantHeight = Math.round(maxEdge / 2)
  const places: [number, number][] = [
    [0, 0],
    [quadrantWidth, 0],
    [0, quadrantHeight],
    [quadrantWidth, quadrantHeight],
  ]

  const tiles: sharp.OverlayOptions[] = []
  for (const [index, image] of usable.entries()) {
    const place = places[index]
    if (place === undefined) break

    const tile = await resizedImage(image, 'image/jpeg', Math.max(quadrantWidth, quadrantHeight))
    if (tile === null) continue
    tiles.push({ input: tile.bytes, left: place[0], top: place[1] })
  }
  if (tiles.length === 0) return null

  const rendered = await sharp({ create: { width, height: maxEdge, channels: 3, background: '#000000' } })
    .composite(tiles)
    .jpeg()
    .toBuffer({ resolveWithObject: true })

  return { bytes: rendered.data, width: rendered.info.width, height: rendered.info.height, mediaType: 'image/jpeg' }
}
