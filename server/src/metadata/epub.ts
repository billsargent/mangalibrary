/**
 * The package document of an EPUB, which is where an EPUB keeps its metadata.
 *
 * An EPUB is a zip holding XHTML, and its metadata is Dublin Core in an OPF
 * package document: a title, one or more creators with roles, a description that
 * is really HTML, a date, a publisher, a language, subjects that are genres, an
 * identifier that may be an ISBN, and the collection the book belongs to with its
 * position in it.
 *
 * As everywhere else in this module, the document is read with targeted patterns
 * rather than by taking on an XML dependency.
 */

import { validatedIsbn } from './isbn.js'
import { normalisedLanguage } from './language.js'
import type { Author, BookMetadataPatch, SeriesMetadataPatch } from './patches.js'
import { attribute, elementsNamed, elementPlainText, elementText, plainText } from './xml.js'

/**
 * The roles an EPUB's creators carry, from the MARC relator codes.
 *
 * A creator with no role, or with one that is not in this list, is a writer: that
 * is what a book without roles means, and what the reference assumes.
 */
export const EPUB_RELATORS: ReadonlyMap<string, string> = new Map([
  ['aut', 'writer'],
  ['clr', 'colorist'],
  ['cov', 'cover'],
  ['edt', 'editor'],
  ['art', 'penciller'],
  ['ill', 'penciller'],
  ['trl', 'translator'],
])

/** The `<metadata>` section, which is all this reader is interested in. */
function metadataSection(xml: string): string {
  const match = /<(?:\w+:)?metadata\b[^>]*>([\s\S]*?)<\/(?:\w+:)?metadata\s*>/i.exec(xml)
  return match?.[1] ?? xml
}

/** The `refines` target of a `meta` element, as the id it refers to. */
function refinedId(tag: string): string | null {
  const refines = attribute(tag, 'refines')
  return refines === null ? null : refines.replace(/^#/, '')
}

/** The words an element carries, or null when it carries none. */
function textOf(element: { inner: string }): string | null {
  const text = plainText(element.inner)
  return text === '' ? null : text
}

/**
 * A date as an EPUB writes one.
 *
 * `dc:date` is at best a date and at worst a full timestamp with a timezone, so
 * the date part is taken and the rest ignored - the same three shapes the
 * reference tries in turn. A date the calendar does not have is dropped.
 */
export function epubReleaseDate(value: string | null): string | undefined {
  if (value === null) return undefined

  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(value.trim())
  if (match?.[1] === undefined) return undefined

  const [year, month, day] = match[1].split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  const hasIt = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return hasIt ? match[1] : undefined
}

/** The credited people, taking a role from `opf:role` or from a refined `meta`. */
function creators(section: string): Author[] {
  const roles = new Map<string, string>()
  for (const element of elementsNamed(section, 'meta')) {
    const property = attribute(element.tag, 'property')
    const id = refinedId(element.tag)
    if (property !== 'role' || id === null) continue
    const value = textOf(element)
    if (value !== null) roles.set(id, value)
  }

  const authors: Author[] = []
  for (const element of elementsNamed(section, 'creator')) {
    const name = textOf(element)
    if (name === null) continue

    const id = attribute(element.tag, 'id')
    const code = attribute(element.tag, 'opf:role') ?? (id === null ? null : (roles.get(id) ?? null))
    authors.push({ name, role: (code === null ? undefined : EPUB_RELATORS.get(code)) ?? 'writer' })
  }
  return authors
}

/** The first identifier that is an ISBN, however it is written. */
function isbnOf(section: string): string | null {
  for (const element of elementsNamed(section, 'identifier')) {
    const text = textOf(element)
    if (text === null) continue

    const candidate = text
      .toLowerCase()
      .replace(/^urn:isbn:/, '')
      .replace(/^isbn:/, '')
    const isbn = validatedIsbn(candidate)
    if (isbn !== null) return isbn
  }
  return null
}

/** The collection a book belongs to, and its position in it. */
function collection(section: string): { name: string | null; position: string | null } {
  for (const element of elementsNamed(section, 'meta')) {
    if (attribute(element.tag, 'property') !== 'belongs-to-collection') continue

    const name = textOf(element)
    const id = attribute(element.tag, 'id')
    if (name === null) continue

    let position: string | null = null
    if (id !== null) {
      for (const candidate of elementsNamed(section, 'meta')) {
        if (attribute(candidate.tag, 'property') !== 'group-position') continue
        if (refinedId(candidate.tag) !== id) continue
        position = textOf(candidate)
        break
      }
    }
    return { name, position }
  }
  return { name: null, position: null }
}

/** The reading direction an EPUB states on its spine. */
function readingDirection(xml: string): string | undefined {
  const spine = elementsNamed(xml, 'spine')[0]
  if (spine === undefined) return undefined

  const direction = attribute(spine.tag, 'page-progression-direction')
  if (direction === 'rtl') return 'RIGHT_TO_LEFT'
  if (direction === 'ltr') return 'LEFT_TO_RIGHT'
  return undefined
}

/** What an EPUB's package document says about its book and its series. */
export function epubMetadata(xml: string): { book: BookMetadataPatch; series: SeriesMetadataPatch } {
  const section = metadataSection(xml)

  const book: BookMetadataPatch = {}
  const title = elementText(section, 'title')
  if (title !== null) book.title = title
  const summary = elementPlainText(section, 'description')
  if (summary !== null) book.summary = summary
  const releaseDate = epubReleaseDate(elementText(section, 'date'))
  if (releaseDate !== undefined) book.releaseDate = releaseDate
  const authors = creators(section)
  if (authors.length > 0) book.authors = authors
  const isbn = isbnOf(section)
  if (isbn !== null) book.isbn = isbn

  const { name, position } = collection(section)
  if (position !== null && position !== '') {
    book.number = position
    const numberSort = Number(position)
    if (Number.isFinite(numberSort)) book.numberSort = numberSort
  }

  const series: SeriesMetadataPatch = {}
  if (name !== null) {
    series.title = name
    series.titleSort = name
  }
  const publisher = elementText(section, 'publisher')
  if (publisher !== null) series.publisher = publisher
  const language = normalisedLanguage(elementText(section, 'language'))
  if (language !== null) series.language = language

  const genres: string[] = []
  for (const element of elementsNamed(section, 'subject')) {
    const genre = textOf(element)
    if (genre !== null && !genres.includes(genre)) genres.push(genre)
  }
  if (genres.length > 0) series.genres = genres

  const direction = readingDirection(xml)
  if (direction !== undefined) series.readingDirection = direction

  return { book, series }
}
