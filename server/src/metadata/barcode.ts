/**
 * An ISBN read from a barcode printed on a page.
 *
 * A comic's cover is often the only place an ISBN appears: the code is printed on
 * the back, or inside the front cover. The reference reads the first and last few
 * pages with zxing and validates what it finds, and this does the same with
 * zxing's TypeScript port.
 *
 * Only EAN-13 is looked for, because that is what an ISBN barcode is, and the
 * result goes through the same ISBN validation a document's `isbn` field gets - a
 * barcode that encodes something else is not an ISBN, and is ignored rather than
 * stored.
 */

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'
import sharp from 'sharp'

import { openBook, type BookContents } from '../media/index.js'
import { validatedIsbn } from './isbn.js'
import type { BookMetadataPatch } from './patches.js'

/** How many pages at each end of a book are searched, as the reference searches. */
const PAGES_LAST = 3
const PAGES_FIRST = 3

/**
 * The pages to look at: the last few, from the back, then the first few.
 *
 * A barcode is normally on the back cover or inside the front, and in a comic
 * those are the last and first pages.
 */
export function pagesToSearch(pageCount: number): number[] {
  const pages = Array.from({ length: pageCount }, (_unused, index) => index + 1)
  return [...new Set([...pages.slice(-PAGES_LAST).reverse(), ...pages.slice(0, PAGES_FIRST)])]
}

/** The text of an EAN-13 barcode in an image, or null when there is none. */
export function barcodeText(pixels: Uint8ClampedArray, width: number, height: number): string | null {
  const source = new RGBLuminanceSource(pixels, width, height)
  const bitmap = new BinaryBitmap(new HybridBinarizer(source))
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13])
  hints.set(DecodeHintType.TRY_HARDER, true)

  try {
    return new MultiFormatReader().decode(bitmap, hints).getText()
  } catch {
    // No barcode, or one this cannot read: the reference treats both the same way.
    return null
  }
}

/** The text of an EAN-13 barcode in an image, or null when there is none. */
export async function barcodeInImage(image: Buffer): Promise<string | null> {
  try {
    // One byte of brightness per pixel, which is what the reader's luminance source
    // takes - handing it colour bytes would read the channels as pixels.
    const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true })
    return barcodeText(new Uint8ClampedArray(data), info.width, info.height)
  } catch {
    // Bytes that are not an image have no barcode in them.
    return null
  }
}

/** An ISBN read from a barcode on one of a book's pages, or null. */
export async function isbnBarcodePatch(path: string): Promise<BookMetadataPatch | null> {
  let book: BookContents | null = null
  try {
    book = await openBook(path)
    // A reflowable EPUB has no page that is an image, so there is nothing to read.
    if (book.kind === 'EPUB') return null

    for (const page of pagesToSearch(book.pages.length)) {
      const image = await book.readPage(page).catch(() => null)
      if (image === null) continue

      const text = await barcodeInImage(image)
      if (text === null) continue

      const isbn = validatedIsbn(text)
      if (isbn !== null) return { isbn }
    }
    return null
  } catch {
    // A file this server cannot open has no barcode worth reporting.
    return null
  } finally {
    book?.close()
  }
}
