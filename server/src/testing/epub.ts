/**
 * Test-only helpers for building an EPUB.
 *
 * An EPUB is a zip with a container document that names a package document, which
 * names the chapters. Only the parts the server reads are built here, so a test can
 * state the metadata it is interested in and nothing else - and add entries of its
 * own, which is how a book carrying both an EPUB package and a ComicInfo document
 * is built.
 */

import { writeZip } from './zip.js'

/**
 * A package document around a `<metadata>` section.
 *
 * The chapter is real, because an EPUB without a spine is not a book the server
 * opens at all.
 */
export function opfDocument(metadata: string, spine: { attributes?: string } = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${metadata}
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine${spine.attributes === undefined ? '' : ` ${spine.attributes}`}>
    <itemref idref="chapter1"/>
  </spine>
</package>`
}

/** The entries an EPUB holds, before they are zipped. */
export function epubEntries(metadata: string, spine: { attributes?: string } = {}): { name: string; data: Buffer }[] {
  return [
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
          '</container>',
      ),
    },
    { name: 'OEBPS/content.opf', data: Buffer.from(opfDocument(metadata, spine), 'utf8') },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from('<html><body><p>one</p></body></html>', 'utf8') },
  ]
}

/** The zip an EPUB is, around a package document. */
export function epubBuffer(metadata: string, spine: { attributes?: string } = {}): Buffer {
  return writeZip(epubEntries(metadata, spine))
}
