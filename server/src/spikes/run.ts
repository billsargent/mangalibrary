/**
 * P0 spikes (issue #3).
 *
 * Each spike exercises a risky library substitution and reports PASS/FAIL.
 * Run with: npm run spike
 */
import { nextTsid, decodeTsid } from '../tsid.js'
import { minimalPdf } from './minimalPdf.js'

let failures = 0
async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn()
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ''}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name} - ${(err as Error).message}`)
  }
}

async function spikes() {
  // ---------------------------------------------------------------- images
  const sharpMod = await import('sharp')
  const sharp = sharpMod.default

  await check('sharp: encode + decode JPEG/PNG/WebP/TIFF', async () => {
    const base = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    const png = await base.clone().png().toBuffer()
    const jpeg = await base.clone().jpeg().toBuffer()
    const webp = await base.clone().webp().toBuffer()
    const tiff = await base.clone().tiff().toBuffer()
    const sizes: string[] = []
    for (const b of [png, jpeg, webp, tiff]) sizes.push((await sharp(b).metadata()).format ?? '?')
    return `formats=${sizes.join(',')}`
  })

  await check('sharp: thumbnail resize -> jpeg', async () => {
    const png = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#808080' } })
      .png()
      .toBuffer()
    const thumb = await sharp(png).resize(300, 300, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
    const meta = await sharp(thumb).metadata()
    return `${meta.width}x${meta.height} ${meta.format} ${thumb.length}B`
  })

  // ------------------------------------------------------------------ TSID
  await check('tsid: 13-char Crockford, monotonic, round-trip', () => {
    const ids: string[] = []
    for (let i = 0; i < 2000; i++) ids.push(nextTsid())
    const alphabet = /^[0-9A-HJKMNP-TV-Z]{13}$/
    for (const id of ids) if (!alphabet.test(id)) throw new Error(`bad id: ${id}`)
    for (let i = 1; i < ids.length; i++) if (ids[i - 1]! > ids[i]!) throw new Error(`not sorted at ${i}`)
    const decoded = decodeTsid(ids[0]!)
    if (Number.isNaN(decoded.date.getTime())) throw new Error('decode failed')
    return `sample=${ids[0]} date=${decoded.date.toISOString()}`
  })

  // -------------------------------------------------------------- archives
  const SevenZip = (await import('7z-wasm')).default
  const sz = await SevenZip()

  const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } })
    .jpeg()
    .toBuffer()
  sz.FS.writeFile('page1.jpg', new Uint8Array(jpeg))
  sz.FS.writeFile('page2.jpg', new Uint8Array(jpeg))

  await check('7z-wasm: create CBZ (zip)', () => {
    sz.callMain(['a', '-tzip', 'book.cbz', 'page1.jpg', 'page2.jpg'])
    const bytes = sz.FS.readFile('book.cbz')
    if (bytes.length === 0) throw new Error('empty zip')
    return `${bytes.length}B`
  })

  await check('yauzl: read CBZ entries', async () => {
    const bytes = Buffer.from(sz.FS.readFile('book.cbz'))
    const entries = await readZipEntries(bytes)
    const images = entries.filter((e) => /\.jpe?g$/i.test(e))
    if (images.length !== 2) throw new Error(`expected 2 images, got ${images.length}: ${entries.join(',')}`)
    return entries.join(',')
  })

  await check('7z-wasm: create + extract CB7 (7z)', () => {
    sz.callMain(['a', '-t7z', 'book.cb7', 'page1.jpg'])
    sz.FS.mkdir('/out7z')
    sz.callMain(['x', '-y', '-o/out7z', 'book.cb7'])
    const out = sz.FS.readdir('/out7z').filter((f: string) => f !== '.' && f !== '..')
    if (out.length === 0) throw new Error('nothing extracted')
    return out.join(',')
  })

  await check('node-unrar-js: API loads', async () => {
    const mod = await import('node-unrar-js')
    if (typeof mod.createExtractorFromData !== 'function') throw new Error('createExtractorFromData missing')
    return 'createExtractorFromData available (RAR fixture still needed)'
  })

  // ------------------------------------------------------------------- PDF
  await check('mupdf: render page 1 -> PNG', async () => {
    const mupdf: any = await import('mupdf')
    const doc = mupdf.Document.openDocument(minimalPdf(), 'application/pdf')
    const page = doc.loadPage(0)
    const pix = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = pix.asPNG()
    if (png.length === 0) throw new Error('empty pixmap')
    return `${pix.getWidth()}x${pix.getHeight()} ${png.length}B`
  })

  // --------------------------------------------------------------- numbers
  await check('file-type: magic-byte detection', async () => {
    const { fileTypeFromBuffer } = await import('file-type')
    const t = await fileTypeFromBuffer(new Uint8Array(jpeg))
    if (t?.ext !== 'jpg') throw new Error(`expected jpg, got ${t?.ext}`)
    return `${t.mime}`
  })
}

async function readZipEntries(buf: Buffer): Promise<string[]> {
  const yauzl = (await import('yauzl')).default
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'))
      const names: string[] = []
      zipfile.on('entry', (entry) => {
        names.push(entry.fileName)
        zipfile.readEntry()
      })
      zipfile.on('end', () => resolve(names))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

spikes()
  .then(() => {
    console.log('')
    console.log(failures === 0 ? 'ALL SPIKES PASSED' : `${failures} SPIKE(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('spike runner crashed:', err)
    process.exit(1)
  })
