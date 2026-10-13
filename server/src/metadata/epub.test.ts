import { describe, expect, it } from 'vitest'
import { opfDocument } from '../testing/epub.js'
import { epubMetadata, epubReleaseDate, EPUB_RELATORS } from './epub.js'

/** What a typical EPUB says about itself. */
const TYPICAL = opfDocument(`
  <dc:title>The Long Way Down</dc:title>
  <dc:creator id="cre1">A Writer</dc:creator>
  <dc:creator id="cre2">An Artist</dc:creator>
  <meta refines="#cre2" property="role" scheme="marc:relators">art</meta>
  <dc:description>&lt;p&gt;A &lt;b&gt;long&lt;/b&gt; way down.&lt;/p&gt;</dc:description>
  <dc:date>2019-04-02T00:00:00+02:00</dc:date>
  <dc:publisher>Some Press</dc:publisher>
  <dc:language>en-GB</dc:language>
  <dc:subject>Science Fiction</dc:subject>
  <dc:subject>Adventure</dc:subject>
  <dc:identifier id="bookid">urn:isbn:978-1-56619-909-4</dc:identifier>
  <meta property="belongs-to-collection" id="col1">The Long Series</meta>
  <meta refines="#col1" property="group-position">3</meta>
`)

describe('reading an EPUB package document', () => {
  it('reads the book fields', () => {
    const { book } = epubMetadata(TYPICAL)
    expect(book.title).toBe('The Long Way Down')
    // The description is HTML, and what is wanted is the words.
    expect(book.summary).toBe('A long way down.')
    expect(book.releaseDate).toBe('2019-04-02')
    expect(book.isbn).toBe('9781566199094')
    expect(book.number).toBe('3')
    expect(book.numberSort).toBe(3)
  })

  it('reads the credits, with a role from opf:role or a refined meta', () => {
    const { book } = epubMetadata(TYPICAL)
    expect(book.authors).toEqual([
      { name: 'A Writer', role: 'writer' },
      { name: 'An Artist', role: 'penciller' },
    ])
  })

  it('reads the series fields, including the reading direction from the spine', () => {
    const { series } = epubMetadata(opfDocument('', { attributes: 'page-progression-direction="rtl"' }))
    expect(series.readingDirection).toBe('RIGHT_TO_LEFT')

    const { series: leftToRight } = epubMetadata(
      opfDocument('<dc:title>A book</dc:title>', { attributes: 'page-progression-direction="ltr"' }),
    )
    expect(leftToRight.readingDirection).toBe('LEFT_TO_RIGHT')

    const { series: unspecified } = epubMetadata(opfDocument('<dc:title>A book</dc:title>'))
    expect(unspecified.readingDirection).toBeUndefined()
  })

  it('reads the collection, the publisher, the language and the genres', () => {
    const { series } = epubMetadata(TYPICAL)
    expect(series.title).toBe('The Long Series')
    expect(series.titleSort).toBe('The Long Series')
    expect(series.publisher).toBe('Some Press')
    expect(series.language).toBe('en-GB')
    expect(series.genres).toEqual(['Science Fiction', 'Adventure'])
  })

  it('reads a package document whether or not it uses prefixes', () => {
    const plain = opfDocument('<title>No Prefix</title><creator>Nobody</creator><language>en</language>')
    const { book, series } = epubMetadata(plain)
    expect(book.title).toBe('No Prefix')
    expect(book.authors).toEqual([{ name: 'Nobody', role: 'writer' }])
    expect(series.language).toBe('en')
  })

  it('leaves out what the document does not carry', () => {
    const { book, series } = epubMetadata(opfDocument('<dc:title>Only a title</dc:title>'))
    expect(book).toEqual({ title: 'Only a title' })
    expect(series).toEqual({})
  })

  it('reads an empty document as empty patches', () => {
    expect(epubMetadata(opfDocument(''))).toEqual({ book: {}, series: {} })
  })

  describe('the credits', () => {
    it('calls a creator without a role a writer, and one with an unknown code too', () => {
      const { book } = epubMetadata(
        opfDocument(
          '<dc:creator>No Role</dc:creator><dc:creator opf:role="zzz">Odd Code</dc:creator>' +
            '<dc:creator opf:role="cov">A Cover Artist</dc:creator>',
        ),
      )
      expect(book.authors).toEqual([
        { name: 'No Role', role: 'writer' },
        { name: 'Odd Code', role: 'writer' },
        { name: 'A Cover Artist', role: 'cover' },
      ])
    })

    it('knows the relator codes the reference knows', () => {
      const names = [...EPUB_RELATORS.keys()].sort()
      expect(names).toEqual(['art', 'aut', 'clr', 'cov', 'edt', 'ill', 'trl'])
    })

    it('ignores a role that refines nothing', () => {
      const { book } = epubMetadata(
        opfDocument('<meta property="role" scheme="marc:relators">art</meta><dc:creator>Someone</dc:creator>'),
      )
      expect(book.authors).toEqual([{ name: 'Someone', role: 'writer' }])
    })
  })

  describe('the release date', () => {
    it('takes the date part of a timestamp', () => {
      expect(epubReleaseDate('2019-04-02T12:30:00Z')).toBe('2019-04-02')
      expect(epubReleaseDate('2019-04-02 12:30:00')).toBe('2019-04-02')
      expect(epubReleaseDate('2019-04-02')).toBe('2019-04-02')
    })

    it('drops a date the calendar does not have, and one that is not a date', () => {
      expect(epubReleaseDate('2019-02-30')).toBeUndefined()
      expect(epubReleaseDate('2019')).toBeUndefined()
      expect(epubReleaseDate('April 2019')).toBeUndefined()
      expect(epubReleaseDate(null)).toBeUndefined()
    })
  })

  describe('the identifier', () => {
    it('is an ISBN when one of the identifiers is one', () => {
      const { book } = epubMetadata(
        opfDocument('<dc:identifier>urn:uuid:6e8bc430</dc:identifier><dc:identifier>isbn:0306406152</dc:identifier>'),
      )
      expect(book.isbn).toBe('0306406152')
    })

    it('is left out when none of them is', () => {
      const { book } = epubMetadata(opfDocument('<dc:identifier>urn:uuid:6e8bc430</dc:identifier>'))
      expect(book.isbn).toBeUndefined()
    })
  })
})

describe('an EPUB whose metadata has elements that close themselves', () => {
  // How calibre and most EPUB 2 tools write the cover and their own fields.
  const MIXED = `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Volume 2</dc:title>
  <meta name="cover" content="cover-image"/>
  <meta name="calibre:series" content="The Long Series" />
  <meta property="belongs-to-collection" id="col1">The Long Series</meta>
  <meta refines="#col1" property="group-position">2</meta>
  <dc:creator id="a1">Someone</dc:creator>
  <meta refines='#a1' property='role' scheme='marc:relators'>ill</meta>
  <dc:identifier guid="not-the-id" id="bookid">isbn:9781566199094</dc:identifier>
</metadata><spine page-progression-direction="rtl"><itemref idref="p1"/></spine></package>`

  it('still finds the series and the book’s place in it', () => {
    const { book, series } = epubMetadata(MIXED)
    expect(series.title).toBe('The Long Series')
    expect(book.number).toBe('2')
    expect(book.numberSort).toBe(2)
  })

  it('reads attributes quoted either way, and the rest of the document', () => {
    const { book, series } = epubMetadata(MIXED)
    expect(book.title).toBe('Volume 2')
    expect(book.authors).toEqual([{ name: 'Someone', role: 'penciller' }])
    expect(book.isbn).toBe('9781566199094')
    expect(series.readingDirection).toBe('RIGHT_TO_LEFT')
  })
})
