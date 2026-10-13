import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { minimalPdf } from '../spikes/minimalPdf.js'
import { writeRar } from '../testing/rar.js'
import { writeZip } from '../testing/zip.js'
import { onReader, onThread, startThreads, stopThreads } from '../threads/index.js'
import { inspectBook } from './inspect.js'
import { closeKeptBook, keptOpen } from './kept-open.js'
import { readBookPage } from './pages.js'
import { PDF_LONG_EDGE, pdfPageSize } from './pdf.js'

const folder = (): string => mkdtempSync(join(tmpdir(), 'ml-pages-'))
const image = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer()

afterEach(async () => {
  closeKeptBook()
  await stopThreads()
})

describe('the size a PDF page is drawn at', () => {
  it('puts the longer side at the size chosen, whichever side that is', () => {
    // A4 on paper, upright and on its side.
    expect(pdfPageSize([0, 0, 595, 842])).toMatchObject({ width: 1131, height: PDF_LONG_EDGE })
    expect(pdfPageSize([0, 0, 842, 595])).toMatchObject({ width: PDF_LONG_EDGE, height: 1131 })
    // A page whose corner is not at nought.
    expect(pdfPageSize([100, 100, 695, 942])).toMatchObject({ width: 1131, height: PDF_LONG_EDGE })
  })

  it('makes a large page smaller and does not blow a tiny one up without limit', () => {
    expect(pdfPageSize([0, 0, 3200, 1600])).toMatchObject({ scale: 0.5, width: 1600, height: 800 })
    expect(pdfPageSize([0, 0, 10, 10])).toMatchObject({ scale: 8, width: 80, height: 80 })
    expect(pdfPageSize([0, 0, 0, 0])).toMatchObject({ scale: 1, width: 1, height: 1 })
  })

  it('is what analysis records, and what a page then comes out as', async () => {
    const path = join(folder(), 'v1.pdf')
    writeFileSync(path, minimalPdf())

    // Without asking for dimensions: a PDF knows, and nothing is drawn to find out.
    const inspection = await inspectBook(path)
    expect(inspection.status).toBe('READY')
    const [first] = inspection.pages
    expect(Math.max(first!.width!, first!.height!)).toBe(PDF_LONG_EDGE)

    const read = await readBookPage(path, 1)
    if (!('bytes' in read)) throw new Error('the page was not read')
    const drawn = await sharp(read.bytes).metadata()
    // The drawing rounds outwards, so it may be a pixel larger than the sum.
    expect(Math.abs((drawn.width ?? 0) - first!.width!)).toBeLessThanOrEqual(1)
    expect(Math.abs((drawn.height ?? 0) - first!.height!)).toBeLessThanOrEqual(1)
  })
})

describe('reading a page', () => {
  it('reads a page of every kind of book, and says which way it failed', async () => {
    const dir = folder()
    const page = await image(20, 30)
    const cbz = join(dir, 'a.cbz')
    const cbr = join(dir, 'b.cbr')
    const pdf = join(dir, 'c.pdf')
    writeFileSync(cbz, writeZip([{ name: '1.jpg', data: page }]))
    writeFileSync(cbr, writeRar([{ name: '1.jpg', data: page }]))
    writeFileSync(pdf, minimalPdf())

    for (const path of [cbz, cbr]) {
      const read = await readBookPage(path, 1)
      expect('bytes' in read && read.bytes.equals(page)).toBe(true)
      expect('bytes' in read && read.mediaType).toBe('image/jpeg')
    }
    const drawn = await readBookPage(pdf, 1)
    expect('bytes' in drawn && drawn.mediaType).toBe('image/jpeg')

    for (const path of [cbz, cbr, pdf]) {
      expect(await readBookPage(path, 99)).toEqual({ failed: 'PAGE' })
      expect(await readBookPage(path, 0)).toEqual({ failed: 'PAGE' })
    }
    for (const name of ['gone.cbz', 'gone.cbr', 'gone.pdf']) {
      expect(await readBookPage(join(dir, name), 1)).toEqual({ failed: 'OPEN' })
    }
  })

  it('reads a CBR and a PDF on a reader thread, the same one for the same book', async () => {
    startThreads({ maxThreads: 2 })
    const dir = folder()
    const page = await image(20, 30)
    const cbr = join(dir, 'b.cbr')
    writeFileSync(
      cbr,
      writeRar([
        { name: '1.jpg', data: page },
        { name: '2.jpg', data: page },
      ]),
    )

    const read = await readBookPage(cbr, 2)
    expect('bytes' in read && read.bytes.equals(page)).toBe(true)

    const main = await onThread('whichThread', {})
    const first = await onReader(cbr, 'whichThread', {})
    const again = await onReader(cbr, 'whichThread', {})
    expect(first.main).toBe(false)
    expect(again.id).toBe(first.id)
    // Not one of the threads a scan's jobs run on.
    expect(first.id).not.toBe(main.id)
  })
})

describe('a book kept open', () => {
  it('is opened once for page after page', async () => {
    const path = join(folder(), 'v1.pdf')
    writeFileSync(path, minimalPdf())

    const first = await keptOpen(path)
    expect(await keptOpen(path)).toBe(first)
  })

  it('is let go of for another book, and opened again when its file changes', async () => {
    const dir = folder()
    const one = join(dir, 'one.cbr')
    const two = join(dir, 'two.cbr')
    writeFileSync(one, writeRar([{ name: '1.jpg', data: await image(10, 10) }]))
    writeFileSync(two, writeRar([{ name: '1.jpg', data: await image(10, 10) }]))

    const first = await keptOpen(one)
    const other = await keptOpen(two)
    expect(other).not.toBe(first)
    expect(await keptOpen(one)).not.toBe(first)

    // The same path, and another file behind it.
    const before = await keptOpen(two)
    writeFileSync(
      two,
      writeRar([
        { name: '1.jpg', data: await image(10, 10) },
        { name: '2.jpg', data: await image(12, 12) },
      ]),
    )
    const after = await keptOpen(two)
    expect(after).not.toBe(before)
    expect(after.pageCount).toBe(2)
  })
})
