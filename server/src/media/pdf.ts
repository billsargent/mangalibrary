import type { PageEntry } from './types.js'

/** A page of a PDF, rendered on demand. */
export interface PdfDocument {
  pageCount: number
  pages(): PageEntry[]
  readPage(pageNumber: number): Promise<Buffer>
  /** One page as a PDF of that page alone. */
  readPageAsPdf(pageNumber: number): Promise<Buffer>
  close(): void
}

/**
 * How many pixels the longer side of a page is drawn at.
 *
 * A PDF's page has a size on paper and no size in pixels: whoever draws it
 * chooses. Drawn at the paper size - 72 pixels to the inch - a page is about 600
 * by 840, which is soft on any screen. This is sharp on a laptop or a tablet and
 * still quick to draw and to send. The reference draws at 3200.
 */
export const PDF_LONG_EDGE = 1600

/** High enough that text drawn on a page keeps clean edges. */
const PDF_JPEG_QUALITY = 90

/** A page smaller than a postage stamp is not blown up without limit. */
const MAX_SCALE = 8

/** How much a page of the given size on paper is enlarged, and the pixels that makes. */
export function pdfPageSize(bounds: readonly [number, number, number, number]): {
  scale: number
  width: number
  height: number
} {
  const width = Math.abs(bounds[2] - bounds[0])
  const height = Math.abs(bounds[3] - bounds[1])
  const longest = Math.max(width, height)
  const scale = longest > 0 ? Math.min(PDF_LONG_EDGE / longest, MAX_SCALE) : 1
  return { scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * Open a PDF.
 *
 * A PDF has no files inside it, so its "pages" are described rather than listed:
 * each one is rendered to a JPEG at read time, which is what a reader needs and
 * what the reference does too (it renders through the same library).
 */
export async function openPdf(buffer: Buffer): Promise<PdfDocument> {
  // The bindings are untyped; keep the casts in one place.
  const mupdf = (await import('mupdf')) as unknown as {
    Document: { openDocument(data: Buffer, magic: string): unknown }
    PDFDocument: new () => {
      graftPage(to: number, source: unknown, page: number): void
      saveToBuffer(options: string): { asUint8Array(): Uint8Array }
      destroy?(): void
    }
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
        asJPEG(quality: number): Uint8Array
        getWidth(): number
        getHeight(): number
      }
    }
    asPDF(): unknown
    destroy?(): void
  }

  const pageCount = document.countPages()

  return {
    pageCount,
    pages: () =>
      Array.from({ length: pageCount }, (_unused, index) => {
        // How large a page will be drawn is known from its size on paper, without
        // drawing it. How many bytes that will be is not.
        const { width, height } = pdfPageSize(document.loadPage(index).getBounds())
        return { fileName: `${index + 1}.jpg`, mediaType: 'image/jpeg', size: null, width, height }
      }),
    readPage: async (pageNumber) => {
      const index = pageNumber - 1
      if (index < 0 || index >= pageCount) throw new Error(`page ${pageNumber} is out of range`)

      const page = document.loadPage(index)
      const { scale } = pdfPageSize(page.getBounds())
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false)
      // A JPEG, as the reference sends: a drawn page is most often a scan, which a
      // PNG makes several times larger and several times slower to encode.
      return Buffer.from(pixmap.asJPEG(PDF_JPEG_QUALITY))
    },
    readPageAsPdf: async (pageNumber) => {
      const index = pageNumber - 1
      if (index < 0 || index >= pageCount) throw new Error(`page ${pageNumber} is out of range`)

      const source = document.asPDF()
      if (source === null) throw new Error('not a PDF')
      // The page is carried into a new document with everything it draws with -
      // fonts, images - and nothing of the pages around it.
      const single = new mupdf.PDFDocument()
      try {
        single.graftPage(-1, source, index)
        return Buffer.from(single.saveToBuffer('compress').asUint8Array())
      } finally {
        single.destroy?.()
      }
    },
    close: () => document.destroy?.(),
  }
}
