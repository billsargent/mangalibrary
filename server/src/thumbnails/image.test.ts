import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THUMBNAIL_SIZE, MOSAIC_RATIO, THUMBNAIL_SIZES, maxEdgeFor, mosaic, resizedImage } from './image.js'

/** The colour the fixtures are made of, when a test does not care. */
const BLUE = { r: 10, g: 20, b: 30 }

/** A real JPEG of a stated size. */
async function jpeg(width: number, height: number, colour = BLUE): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg()
    .toBuffer()
}

/** A real PNG of a stated size. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer()
}

/** The pixel at a point, as sharp decodes it. */
async function pixelAt(image: Buffer, left: number, top: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  const offset = (top * info.width + left) * info.channels
  return { r: data[offset] ?? 0, g: data[offset + 1] ?? 1, b: data[offset + 2] ?? 2 }
}

/**
 * Check a pixel is the colour expected.
 *
 * Compared with room to spare: a mosaic is a JPEG, and a JPEG is lossy, so a solid
 * patch comes back a shade or two away from what went in.
 */
async function expectPixel(image: Buffer, left: number, top: number, expected: typeof BLUE): Promise<void> {
  const actual = await pixelAt(image, left, top)
  for (const channel of ['r', 'g', 'b'] as const) {
    expect(Math.abs(actual[channel] - expected[channel]), `${channel} at ${left},${top}`).toBeLessThanOrEqual(16)
  }
}

describe('thumbnail sizes', () => {
  it('knows the four sizes the settings allow', () => {
    expect(THUMBNAIL_SIZES).toEqual({ DEFAULT: 300, MEDIUM: 600, LARGE: 900, XLARGE: 1200 })
    expect(maxEdgeFor('LARGE')).toBe(900)
  })

  it('falls back to the default for an unset or unknown size', () => {
    expect(maxEdgeFor(undefined)).toBe(DEFAULT_THUMBNAIL_SIZE)
    expect(maxEdgeFor(null)).toBe(300)
    // A server set to something this build does not know still shows posters.
    expect(maxEdgeFor('ENORMOUS')).toBe(300)
  })
})

describe('resizing an image', () => {
  it('shrinks an image to fit inside a square, keeping its shape', async () => {
    const rendered = await resizedImage(await png(400, 600), 'image/png', 300)
    expect(rendered?.width).toBe(200)
    expect(rendered?.height).toBe(300)
    // Everything stored or served is a JPEG, as the reference converts it.
    expect(rendered?.mediaType).toBe('image/jpeg')
    expect((await sharp(rendered!.bytes).metadata()).format).toBe('jpeg')
  })

  it('never enlarges what is already smaller', async () => {
    const rendered = await resizedImage(await png(40, 60), 'image/png', 300)
    expect(rendered?.width).toBe(40)
    expect(rendered?.height).toBe(60)
  })

  it('passes a JPEG that already fits through untouched', async () => {
    const small = await jpeg(40, 60)
    const rendered = await resizedImage(small, 'image/jpeg', 300)
    expect(rendered?.bytes.equals(small)).toBe(true)
    expect(rendered?.width).toBe(40)
  })

  it('re-encodes a JPEG that is too big', async () => {
    const big = await jpeg(600, 900)
    const rendered = await resizedImage(big, 'image/jpeg', 300)
    expect(rendered?.bytes.equals(big)).toBe(false)
    expect(rendered?.height).toBe(300)
    expect(rendered?.width).toBe(200)
  })

  it('reports bytes that are not an image rather than throwing', async () => {
    expect(await resizedImage(Buffer.from('not an image'), 'image/jpeg', 300)).toBeNull()
    expect(await resizedImage(Buffer.alloc(0), 'image/png', 300)).toBeNull()
  })
})

describe('a mosaic', () => {
  it('is cover shaped, and as tall as the size in force', async () => {
    const built = await mosaic([await jpeg(40, 60)], 300)
    expect(built?.height).toBe(300)
    expect(built?.width).toBe(Math.round(300 * MOSAIC_RATIO))
    expect(built?.mediaType).toBe('image/jpeg')
  })

  it('draws each image in its own quarter', async () => {
    const colours = [
      { r: 200, g: 0, b: 0 },
      { r: 0, g: 200, b: 0 },
      { r: 0, g: 0, b: 200 },
      { r: 200, g: 200, b: 0 },
    ]
    // Cover shaped tiles, which is what a mosaic is made of: fitted into a quarter
    // they fill it without spilling into the next one.
    const built = await mosaic(await Promise.all(colours.map((colour) => jpeg(60, 90, colour))), 200)

    const half = Math.round((200 * MOSAIC_RATIO) / 2)
    const places: [number, number][] = [
      [10, 10],
      [half + 10, 10],
      [10, 110],
      [half + 10, 110],
    ]
    for (const [index, place] of places.entries()) {
      await expectPixel(built!.bytes, place[0], place[1], colours[index]!)
    }
  })

  it('uses the first four images and ignores the rest', async () => {
    const colours = [
      { r: 200, g: 0, b: 0 },
      { r: 0, g: 200, b: 0 },
      { r: 0, g: 0, b: 200 },
      { r: 200, g: 200, b: 0 },
      { r: 0, g: 200, b: 200 },
    ]
    const built = await mosaic(await Promise.all(colours.map((colour) => jpeg(60, 90, colour))), 200)

    // The bottom right quarter is the fourth image, never the fifth.
    const half = Math.round((200 * MOSAIC_RATIO) / 2)
    await expectPixel(built!.bytes, half + 10, 110, colours[3]!)
  })

  it('leaves the rest of a quarter black, as the reference does', async () => {
    // A small image stays its own size instead of being stretched, so it covers
    // part of its quarter and the black canvas shows beside it.
    const built = await mosaic([await jpeg(40, 60)], 200)
    await expectPixel(built!.bytes, 10, 10, BLUE)
    await expectPixel(built!.bytes, 60, 10, { r: 0, g: 0, b: 0 })
  })

  it('has nothing to show when given nothing', async () => {
    expect(await mosaic([], 300)).toBeNull()
    // Unreadable bytes are dropped, so there is still nothing to show.
    expect(await mosaic([Buffer.from('not an image')], 300)).toBeNull()
  })
})
