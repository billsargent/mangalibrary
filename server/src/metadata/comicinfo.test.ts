import { describe, expect, it } from 'vitest'
import {
  comicInfoBookPatch,
  comicInfoEntry,
  comicInfoReleaseDate,
  comicInfoSeriesPatch,
  COMIC_INFO_ROLES,
} from './comicinfo.js'
import { validatedIsbn } from './isbn.js'

const document = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>Akira</Title>
  <Series>Akira</Series>
  <Number>1.5</Number>
  <Summary>Kaneda &amp; friends, in the ruins.</Summary>
  <Year>1984</Year>
  <Month>12</Month>
  <Day>6</Day>
  <Writer>Katsuhiro Otomo, Someone Else</Writer>
  <Penciller>Katsuhiro Otomo</Penciller>
  <CoverArtist>A Cover Artist</CoverArtist>
  <Tags>Cyberpunk, cyberpunk, Action</Tags>
  <Web>https://example.org/page https://other.example/x</Web>
  <GTIN>978-1-56619-909-4</GTIN>
</ComicInfo>`

describe('reading ComicInfo.xml', () => {
  it('reads the fields a document carries', () => {
    const patch = comicInfoBookPatch(document)

    expect(patch.title).toBe('Akira')
    expect(patch.summary).toBe('Kaneda & friends, in the ruins.')
    expect(patch.number).toBe('1.5')
    expect(patch.numberSort).toBe(1.5)
    expect(patch.releaseDate).toBe('1984-12-06')
    expect(patch.isbn).toBe('9781566199094')
  })

  it('leaves out every field the document does not carry', () => {
    // A hand-written document with three elements cannot wipe the rest.
    const patch = comicInfoBookPatch('<ComicInfo><Title>Only a title</Title></ComicInfo>')
    expect(patch).toEqual({ title: 'Only a title' })
  })

  it('reads an empty document as an empty patch', () => {
    expect(comicInfoBookPatch('<ComicInfo></ComicInfo>')).toEqual({})
    expect(comicInfoBookPatch('<ComicInfo><Title></Title><Summary>  </Summary></ComicInfo>')).toEqual({})
  })

  it('reads elements however they are capitalised', () => {
    const patch = comicInfoBookPatch('<comicinfo><title>Lowercase</title><NUMBER>3</NUMBER></comicinfo>')
    expect(patch.title).toBe('Lowercase')
    expect(patch.number).toBe('3')
  })

  it('turns character references back into characters', () => {
    const patch = comicInfoBookPatch(
      '<ComicInfo><Title>Tom &amp; Jerry &lt;1&gt;</Title><Summary><![CDATA[A & B]]></Summary></ComicInfo>',
    )
    expect(patch.title).toBe('Tom & Jerry <1>')
    expect(patch.summary).toBe('A & B')
  })

  describe('the release date', () => {
    it('defaults the month and the day, as the reference does', () => {
      expect(comicInfoReleaseDate('<ComicInfo><Year>1984</Year></ComicInfo>')).toBe('1984-01-01')
      expect(comicInfoReleaseDate('<ComicInfo><Year>1984</Year><Month>7</Month></ComicInfo>')).toBe('1984-07-01')
    })

    it('is absent when there is no year', () => {
      expect(comicInfoReleaseDate('<ComicInfo><Month>7</Month></ComicInfo>')).toBeUndefined()
    })

    it('is dropped when the calendar does not have it', () => {
      expect(comicInfoReleaseDate('<ComicInfo><Year>1984</Year><Month>13</Month></ComicInfo>')).toBeUndefined()
      expect(
        comicInfoReleaseDate('<ComicInfo><Year>1984</Year><Month>2</Month><Day>30</Day></ComicInfo>'),
      ).toBeUndefined()
    })

    it('knows a leap year', () => {
      expect(comicInfoReleaseDate('<ComicInfo><Year>1984</Year><Month>2</Month><Day>29</Day></ComicInfo>')).toBe(
        '1984-02-29',
      )
      expect(
        comicInfoReleaseDate('<ComicInfo><Year>1983</Year><Month>2</Month><Day>29</Day></ComicInfo>'),
      ).toBeUndefined()
      expect(comicInfoReleaseDate('<ComicInfo><Year>2000</Year><Month>2</Month><Day>29</Day></ComicInfo>')).toBe(
        '2000-02-29',
      )
      expect(
        comicInfoReleaseDate('<ComicInfo><Year>1900</Year><Month>2</Month><Day>29</Day></ComicInfo>'),
      ).toBeUndefined()
    })
  })

  describe('the credited people', () => {
    it('reads one entry per name per role, splitting on commas', () => {
      const patch = comicInfoBookPatch(document)
      expect(patch.authors).toEqual([
        { name: 'Katsuhiro Otomo', role: 'writer' },
        { name: 'Someone Else', role: 'writer' },
        { name: 'Katsuhiro Otomo', role: 'penciller' },
        { name: 'A Cover Artist', role: 'cover' },
      ])
    })

    it('reads every role the reference reads, in the same order', () => {
      const xml = `<ComicInfo>${COMIC_INFO_ROLES.map((role, index) => `<${role.element}>Name ${index}</${role.element}>`).join('')}</ComicInfo>`
      const patch = comicInfoBookPatch(xml)
      expect(patch.authors?.map((author) => author.role)).toEqual(COMIC_INFO_ROLES.map((role) => role.role))
    })

    it('drops blanks and stray commas', () => {
      const patch = comicInfoBookPatch('<ComicInfo><Writer>, , Otomo,</Writer></ComicInfo>')
      expect(patch.authors).toEqual([{ name: 'Otomo', role: 'writer' }])
    })
  })

  describe('the tags', () => {
    it('are lowercased, trimmed and deduplicated', () => {
      const patch = comicInfoBookPatch(document)
      expect(patch.tags).toEqual(['cyberpunk', 'action'])
    })
  })

  describe('the web links', () => {
    it('reads several URLs separated by whitespace', () => {
      const patch = comicInfoBookPatch(document)
      expect(patch.links).toEqual([
        { label: 'example.org', url: 'https://example.org/page' },
        { label: 'other.example', url: 'https://other.example/x' },
      ])
    })

    it('drops an entry that is not a URL and keeps the rest', () => {
      const patch = comicInfoBookPatch('<ComicInfo><Web>not a url https://example.org/ok</Web></ComicInfo>')
      expect(patch.links).toEqual([{ label: 'example.org', url: 'https://example.org/ok' }])
    })
  })

  describe('the ISBN', () => {
    it('is taken from GTIN when it is one', () => {
      expect(comicInfoBookPatch('<ComicInfo><GTIN>978-1-56619-909-4</GTIN></ComicInfo>').isbn).toBe('9781566199094')
      expect(comicInfoBookPatch('<ComicInfo><GTIN>0-306-40615-2</GTIN></ComicInfo>').isbn).toBe('0306406152')
    })

    it('is left out when GTIN is something else', () => {
      expect(comicInfoBookPatch('<ComicInfo><GTIN>978-1-56619-909-5</GTIN></ComicInfo>').isbn).toBeUndefined()
      expect(comicInfoBookPatch('<ComicInfo><GTIN>urn:uuid:1234</GTIN></ComicInfo>').isbn).toBeUndefined()
    })
  })

  describe('the number', () => {
    it('is a plain number when it looks like one', () => {
      expect(comicInfoBookPatch('<ComicInfo><Number>12</Number></ComicInfo>').numberSort).toBe(12)
      expect(comicInfoBookPatch('<ComicInfo><Number>1.5</Number></ComicInfo>').numberSort).toBe(1.5)
    })

    it('keeps the text but drops the sort when it is not a number', () => {
      const patch = comicInfoBookPatch('<ComicInfo><Number>1-5</Number></ComicInfo>')
      expect(patch.number).toBe('1-5')
      expect(patch.numberSort).toBeUndefined()
      expect(comicInfoBookPatch('<ComicInfo><Number>0x10</Number></ComicInfo>').numberSort).toBeUndefined()
    })
  })
})

describe('finding the document in a book', () => {
  const files = [
    { fileName: 'page1.jpg', mediaType: 'image/jpeg', size: 1 },
    { fileName: 'folder/comicinfo.XML', mediaType: 'application/xml', size: 1 },
  ]

  it('finds it wherever it sits, whatever the capitalisation', () => {
    expect(comicInfoEntry(files)).toBe('folder/comicinfo.XML')
  })

  it('is null when the book carries none', () => {
    expect(comicInfoEntry([{ fileName: 'page1.jpg', mediaType: 'image/jpeg', size: 1 }])).toBeNull()
  })

  it('is not fooled by a file that merely ends in the same way', () => {
    expect(comicInfoEntry([{ fileName: 'notComicInfo.xml', mediaType: 'application/xml', size: 1 }])).toBeNull()
  })
})

describe('validating an ISBN', () => {
  it('accepts both lengths, with or without hyphens', () => {
    expect(validatedIsbn('978-1-56619-909-4')).toBe('9781566199094')
    expect(validatedIsbn('9781566199094')).toBe('9781566199094')
    expect(validatedIsbn('0306406152')).toBe('0306406152')
    expect(validatedIsbn('0-8044-2957-X')).toBe('080442957X')
  })

  it('rejects a wrong check digit', () => {
    expect(validatedIsbn('978-1-56619-909-5')).toBeNull()
    expect(validatedIsbn('0306406153')).toBeNull()
  })

  it('rejects anything that is not an ISBN', () => {
    expect(validatedIsbn('')).toBeNull()
    expect(validatedIsbn('   ')).toBeNull()
    expect(validatedIsbn('urn:uuid:6e8bc430')).toBeNull()
    expect(validatedIsbn(null)).toBeNull()
  })
})

describe('reading the series a ComicInfo describes', () => {
  it('names the series from the Series element', () => {
    const patch = comicInfoSeriesPatch('<ComicInfo><Series>Akira</Series></ComicInfo>')
    expect(patch.title).toBe('Akira')
    expect(patch.titleSort).toBe('Akira')
  })

  it('appends the volume when the library asks for it, but not for volume 1', () => {
    const xml = '<ComicInfo><Series>Akira</Series><Volume>2</Volume></ComicInfo>'
    expect(comicInfoSeriesPatch(xml, { appendVolume: true }).title).toBe('Akira (2)')
    expect(comicInfoSeriesPatch(xml).title).toBe('Akira')

    const first = '<ComicInfo><Series>Akira</Series><Volume>1</Volume></ComicInfo>'
    expect(comicInfoSeriesPatch(first, { appendVolume: true }).title).toBe('Akira')
  })

  it('reads the publisher, the genres and the book count', () => {
    const patch = comicInfoSeriesPatch(
      '<ComicInfo><Series>Akira</Series><Publisher>Kodansha</Publisher><Genre>Science Fiction, Action, Action</Genre><Count>6</Count></ComicInfo>',
    )
    expect(patch.publisher).toBe('Kodansha')
    expect(patch.genres).toEqual(['Science Fiction', 'Action'])
    expect(patch.totalBookCount).toBe(6)
  })

  it('reads the language, normalised, and drops what is not one', () => {
    expect(comicInfoSeriesPatch('<ComicInfo><LanguageISO>en-US</LanguageISO></ComicInfo>').language).toBe('en-US')
    expect(comicInfoSeriesPatch('<ComicInfo><LanguageISO>pt_br</LanguageISO></ComicInfo>').language).toBe('pt-BR')
    expect(comicInfoSeriesPatch('<ComicInfo><LanguageISO>Unknown</LanguageISO></ComicInfo>').language).toBeUndefined()
  })

  it('reads an age rating as an age, and no age from the values that are not one', () => {
    expect(comicInfoSeriesPatch('<ComicInfo><AgeRating>Teen</AgeRating></ComicInfo>').ageRating).toBe(13)
    expect(comicInfoSeriesPatch('<ComicInfo><AgeRating>Adults Only 18+</AgeRating></ComicInfo>').ageRating).toBe(18)
    expect(
      comicInfoSeriesPatch('<ComicInfo><AgeRating>Rating Pending</AgeRating></ComicInfo>').ageRating,
    ).toBeUndefined()
    expect(comicInfoSeriesPatch('<ComicInfo><AgeRating>Unknown</AgeRating></ComicInfo>').ageRating).toBeUndefined()
  })

  it('takes a reading direction from Manga, and only from the values that state one', () => {
    expect(comicInfoSeriesPatch('<ComicInfo><Manga>No</Manga></ComicInfo>').readingDirection).toBe('LEFT_TO_RIGHT')
    expect(comicInfoSeriesPatch('<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>').readingDirection).toBe(
      'RIGHT_TO_LEFT',
    )
    expect(comicInfoSeriesPatch('<ComicInfo><Manga>Yes</Manga></ComicInfo>').readingDirection).toBeUndefined()
    expect(comicInfoSeriesPatch('<ComicInfo><Manga>Unknown</Manga></ComicInfo>').readingDirection).toBeUndefined()
  })

  it('leaves a summary and a status alone, because a book cannot decide them', () => {
    const patch = comicInfoSeriesPatch('<ComicInfo><Series>Akira</Series><Summary>Neo-Tokyo</Summary></ComicInfo>')
    expect(patch.summary).toBeUndefined()
    expect(patch.status).toBeUndefined()
  })

  it('reads nothing out of a document about a book with no series', () => {
    expect(comicInfoSeriesPatch('<ComicInfo><Title>One Shot</Title></ComicInfo>')).toEqual({})
  })
})

describe('reading the organisation a ComicInfo describes', () => {
  it('puts the book in the read lists its arcs name, with their numbers', () => {
    const patch = comicInfoBookPatch(
      '<ComicInfo><StoryArc>The Long Way, The Short Way</StoryArc><StoryArcNumber>2, 5</StoryArcNumber></ComicInfo>',
    )
    expect(patch.readLists).toEqual([
      { name: 'The Long Way', number: 2 },
      { name: 'The Short Way', number: 5 },
    ])
  })

  it('puts it in an arc without a number when the document states none', () => {
    const patch = comicInfoBookPatch('<ComicInfo><StoryArc>The Long Way</StoryArc></ComicInfo>')
    expect(patch.readLists).toEqual([{ name: 'The Long Way', number: null }])
  })

  it('leaves out a pair whose number cannot be read, as the reference does', () => {
    const patch = comicInfoBookPatch(
      '<ComicInfo><StoryArc>The Long Way, The Short Way</StoryArc><StoryArcNumber>2, later</StoryArcNumber></ComicInfo>',
    )
    expect(patch.readLists).toEqual([{ name: 'The Long Way', number: 2 }])
  })

  it('reads an alternate series as a read list of its own', () => {
    const patch = comicInfoBookPatch(
      '<ComicInfo><AlternateSeries>Akira Color</AlternateSeries><AlternateNumber>7</AlternateNumber></ComicInfo>',
    )
    expect(patch.readLists).toEqual([{ name: 'Akira Color', number: 7 }])

    const named = comicInfoBookPatch('<ComicInfo><AlternateSeries>Akira Color</AlternateSeries></ComicInfo>')
    expect(named.readLists).toEqual([{ name: 'Akira Color', number: null }])
  })

  it('reads both an alternate series and its arcs', () => {
    const patch = comicInfoBookPatch(
      '<ComicInfo><AlternateSeries>Color</AlternateSeries><StoryArc>Arc</StoryArc></ComicInfo>',
    )
    expect(patch.readLists).toEqual([
      { name: 'Color', number: null },
      { name: 'Arc', number: null },
    ])
  })

  it('reads nothing when the document names none', () => {
    expect(comicInfoBookPatch('<ComicInfo><Title>Akira</Title></ComicInfo>').readLists).toBeUndefined()
    expect(comicInfoBookPatch('<ComicInfo><StoryArc>  ,  </StoryArc></ComicInfo>').readLists).toBeUndefined()
  })

  it('puts the series in the collections its SeriesGroup names', () => {
    const patch = comicInfoSeriesPatch(
      '<ComicInfo><Series>Akira</Series><SeriesGroup>Otomo, Cyberpunk, Otomo</SeriesGroup></ComicInfo>',
    )
    expect(patch.collections).toEqual(['Otomo', 'Cyberpunk'])

    expect(comicInfoSeriesPatch('<ComicInfo><Series>Akira</Series></ComicInfo>').collections).toBeUndefined()
    expect(comicInfoSeriesPatch('<ComicInfo><SeriesGroup> , </SeriesGroup></ComicInfo>').collections).toBeUndefined()
  })
})
