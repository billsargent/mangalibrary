import type { PageEntry } from './types.js'

/** A page of a PDF, rendered on demand. */
export interface PdfDocument {
  pageCount: number
  pages(): PageEntry[]
  readPage(pageNumber: number): Promise<Buffer>
  close(): void
}

/**
 * Open a PDF.
 *
 * A PDF has no files inside it, so its "pages" are described rather than listed:
 * each one is rendered to a PNG at read time, which is what a reader needs and
 * what the reference does too (it renders through the same library).
 */
export async function openPdf(buffer: Buffer): Promise<PdfDocument> {
  // The bindings are untyped; keep the casts in one place.
  const mupdf = (await import('mupdf')) as unknown as {
    Document: { openDocument(data: Buffer, magic: string): unknown }
    Matrix: { scale(x: number, y: number): unknown }
    ColorSpace: { DeviceRGB: unknown }
  }

  const document = mupdf.Document.openDocument(buffer, 'application/pdf') as {
    countPages(): number
    loadPage(index: number): {
      getBounds(): [number, number, number, number]
      toPixmap(
        matrix: unknown,
        colorspace: unknown,
        alpha: boolean,
        showExtras: boolean,
      ): {
        asPNG(): Uint8Array
        getWidth(): number
        getHeight(): number
      }
    }
    destroy?(): void
  }

  const pageCount = document.countPages()

  return {
    pageCount,
    pages: () =>
      Array.from({ length: pageCount }, (_unused, index) => ({
        // Sizes are known only once a page is rendered, so they stay unknown here.
        fileName: `${index + 1}.png`,
        mediaType: 'image/png',
        size: null,
      })),
    readPage: async (pageNumber) => {
      const index = pageNumber - 1
      if (index < 0 || index >= pageCount) throw new Error(`page ${pageNumber} is out of range`)

      const page = document.loadPage(index)
      // 1:1 scale is what the reference renders at when it only needs the bytes;
      // the reader asks for a size and gets a resize from sharp.
      const pixmap = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, false)
      return Buffer.from(pixmap.asPNG())
    },
    close: () => document.destroy?.(),
  }
}
