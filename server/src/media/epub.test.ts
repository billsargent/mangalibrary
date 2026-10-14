import { describe, expect, it } from 'vitest'
import { writeZip } from '../testing/zip.js'
import { openEpub } from './epub.js'

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const chapters = ['text/part1.xhtml', 'text/ch1.xhtml', 'text/ch2.xhtml']

/** A book whose table of contents is the given navigation document or NCX. */
async function tocOf(toc: { nav?: string; ncx?: string }) {
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    ${toc.nav === undefined ? '' : '<item id="nav" href="nav/toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
    ${toc.ncx === undefined ? '' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}
    ${chapters.map((href, index) => `<item id="c${index}" href="${href}" media-type="application/xhtml+xml"/>`).join('')}
  </manifest>
  <spine${toc.ncx === undefined ? '' : ' toc="ncx"'}>${chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('')}</spine>
</package>`
  const epub = await openEpub(
    writeZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
      { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
      ...(toc.nav === undefined ? [] : [{ name: 'OEBPS/nav/toc.xhtml', data: Buffer.from(toc.nav) }]),
      ...(toc.ncx === undefined ? [] : [{ name: 'OEBPS/toc.ncx', data: Buffer.from(toc.ncx) }]),
      ...chapters.map((href) => ({ name: `OEBPS/${href}`, data: Buffer.from('<html><body>text</body></html>') })),
    ]),
  )
  epub.container.close()
  return epub.toc
}

describe('table of contents', () => {
  it('keeps the nesting and the fragments of a navigation document', async () => {
    const toc = await tocOf({
      nav: `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="landmarks"><ol><li><a href="../text/ch2.xhtml">Not contents</a></li></ol></nav>
  <nav epub:type="toc"><h1>Contents</h1><ol>
    <li><a href="../text/part1.xhtml">Part <em>One</em></a>
      <ol>
        <li><a href="../text/ch1.xhtml">Chapter 1</a></li>
        <li><a href="../text/ch1.xhtml#s2">Section &amp; two</a></li>
      </ol>
    </li>
    <li><span>Part Two</span>
      <ol><li><a href="../text/ch2.xhtml#start">Chapter 2</a></li></ol>
    </li>
    <li><a href="#notes">Notes</a></li>
  </ol></nav>
</body></html>`,
    })

    expect(toc).toEqual([
      {
        title: 'Part One',
        href: 'OEBPS/text/part1.xhtml',
        children: [
          { title: 'Chapter 1', href: 'OEBPS/text/ch1.xhtml', children: [] },
          { title: 'Section & two', href: 'OEBPS/text/ch1.xhtml#s2', children: [] },
        ],
      },
      {
        // A heading that links nowhere opens where its first entry does.
        title: 'Part Two',
        href: 'OEBPS/text/ch2.xhtml#start',
        children: [{ title: 'Chapter 2', href: 'OEBPS/text/ch2.xhtml#start', children: [] }],
      },
      // A bare fragment points into the navigation document itself.
      { title: 'Notes', href: 'OEBPS/nav/toc.xhtml#notes', children: [] },
    ])
  })

  it('keeps the nesting and the fragments of an NCX', async () => {
    const toc = await tocOf({
      ncx: `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="p1" playOrder="1">
    <navLabel><text>Part One</text></navLabel><content src="text/part1.xhtml"/>
    <navPoint id="c1" playOrder="2">
      <navLabel><text>Chapter 1</text></navLabel><content src="text/ch1.xhtml"/>
      <navPoint id="s2" playOrder="3">
        <navLabel><text>Section 2</text></navLabel><content src="text/ch1.xhtml#s2"/>
      </navPoint>
    </navPoint>
  </navPoint>
  <navPoint id="c2" playOrder="4">
    <navLabel><text>Chapter 2</text></navLabel><content src="text/ch2.xhtml"/>
  </navPoint>
</navMap></ncx>`,
    })

    expect(toc).toEqual([
      {
        title: 'Part One',
        href: 'OEBPS/text/part1.xhtml',
        children: [
          {
            title: 'Chapter 1',
            href: 'OEBPS/text/ch1.xhtml',
            children: [{ title: 'Section 2', href: 'OEBPS/text/ch1.xhtml#s2', children: [] }],
          },
        ],
      },
      { title: 'Chapter 2', href: 'OEBPS/text/ch2.xhtml', children: [] },
    ])
  })
})
