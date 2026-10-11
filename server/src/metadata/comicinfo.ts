/**
 * `ComicInfo.xml`, the metadata document ComicRack writes and most comic
 * collections carry.
 *
 * The reference reads it with an XML mapper; here it is read with the same
 * targeted patterns as the EPUB and the ComicRack reading list, which is enough
 * for a flat document of text elements. Only the fields this server stores are
 * read, and a value that is present but unusable - a release date that is not a
 * date, a `Web` entry that is not a URL - is dropped on its own rather than
 * throwing the whole document away.
 */

import type { FileEntry } from '../media/types.js'
import { validatedIsbn } from './isbn.js'
import { normalisedLanguage } from './language.js'
import type { Author, BookMetadataPatch, ReadListEntry, SeriesMetadataPatch, WebLink } from './patches.js'
import { elementFloat, elementInt, elementText } from './xml.js'

/** The file name, however the archive capitalises it. */
export const COMIC_INFO_FILE = 'comicinfo.xml'

/**
 * The credited roles, in the order the reference reads them.
 *
 * `CoverArtist` becomes `cover`, which is the role the rest of the server and the
 * UI use.
 */
export const COMIC_INFO_ROLES: readonly { element: string; role: string }[] = [
  { element: 'Writer', role: 'writer' },
  { element: 'Penciller', role: 'penciller' },
  { element: 'Inker', role: 'inker' },
  { element: 'Colorist', role: 'colorist' },
  { element: 'Letterer', role: 'letterer' },
  { element: 'CoverArtist', role: 'cover' },
  { element: 'Editor', role: 'editor' },
  { element: 'Translator', role: 'translator' },
]

/**
 * `AgeRating` as an age, for the values ComicRack defines.
 *
 * `Unknown` and `Rating Pending` are not ages, so they leave the field alone, as
 * the reference's enum does by having no number for them.
 */
export const COMIC_INFO_AGE_RATINGS: ReadonlyMap<string, number> = new Map(
  (
    [
      ['Adults Only 18+', 18],
      ['Early Childhood', 3],
      ['Everyone', 0],
      ['Everyone 10+', 10],
      ['G', 0],
      ['Kids to Adults', 6],
      ['M', 17],
      ['MA 15+', 15],
      ['Mature 17+', 17],
      ['PG', 8],
      ['R18+', 18],
      ['Teen', 13],
      ['X18+', 18],
    ] as const
  ).map(([value, age]) => [value.toLowerCase().replace(/\s+/g, ''), age]),
)

/**
 * `Manga`, which is how a document states the reading direction.
 *
 * `Yes` deliberately says nothing: a manga can read either way, and the reference
 * only takes a direction from `No` and `YesAndRightToLeft`.
 */
export const COMIC_INFO_MANGA_DIRECTIONS: ReadonlyMap<string, string> = new Map([
  ['no', 'LEFT_TO_RIGHT'],
  ['yesandrighttoleft', 'RIGHT_TO_LEFT'],
])

/**
 * The `ComicInfo.xml` inside a book, or null when there is none.
 *
 * The reference insists on the document sitting at the root of the archive with
 * that exact spelling. Collections assembled by hand often put it next to the
 * pages instead, so any directory counts, but the file name itself has to be the
 * document's - `notComicInfo.xml` is somebody else's file - and the capitalisation
 * is not held against it.
 */
export function comicInfoEntry(files: readonly FileEntry[]): string | null {
  const found = files.find((file) => {
    const name = file.fileName.split('/').pop() ?? file.fileName
    return name.toLowerCase() === COMIC_INFO_FILE
  })
  return found?.fileName ?? null
}

function daysInMonth(month: number, year: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  if (month === 2 && leap) return 29
  return lengths[month - 1] ?? 0
}

/**
 * The release date, from the three elements a document may carry.
 *
 * A year is what makes a date: without one there is nothing to store, and a month
 * or a day that is missing means the first of the year or the month, as the
 * reference assumes. A date the calendar does not have - a month of 13, a 31st of
 * February - is dropped rather than failing the document.
 */
export function comicInfoReleaseDate(xml: string): string | undefined {
  const year = elementInt(xml, 'Year')
  if (year === null || year < 1 || year > 9999) return undefined

  const month = elementInt(xml, 'Month') ?? 1
  const day = elementInt(xml, 'Day') ?? 1
  if (month < 1 || month > 12) return undefined
  if (day < 1 || day > daysInMonth(month, year)) return undefined

  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** The credited people, one entry per name per role, in the order read. */
function authorsOf(xml: string): Author[] {
  const authors: Author[] = []
  for (const { element, role } of COMIC_INFO_ROLES) {
    const value = elementText(xml, element)
    if (value === null) continue
    for (const name of value.split(',')) {
      const trimmed = name.trim()
      if (trimmed !== '') authors.push({ name: trimmed, role })
    }
  }
  return authors
}

/** The tags, lowercased and deduplicated, as the reference stores them. */
function tagsOf(xml: string): string[] {
  const value = elementText(xml, 'Tags')
  if (value === null) return []

  const tags = new Set<string>()
  for (const tag of value.split(',')) {
    const trimmed = tag.trim().toLowerCase()
    if (trimmed !== '') tags.add(trimmed)
  }
  return [...tags]
}

/** The `Web` element, which may hold several URLs separated by whitespace. */
function linksOf(xml: string): WebLink[] {
  const value = elementText(xml, 'Web')
  if (value === null) return []

  const links: WebLink[] = []
  for (const candidate of value.split(/\s+/)) {
    if (candidate === '') continue
    try {
      const url = new URL(candidate)
      links.push({ label: url.host, url: url.toString() })
    } catch {
      // Not a URL; the reference logs this and keeps the rest.
    }
  }
  return links
}

/**
 * The read lists a document puts its book in.
 *
 * `AlternateSeries` names another list the book belongs to, with `AlternateNumber`
 * as its place in it. `StoryArc` names one or more arcs, and `StoryArcNumber` gives
 * the matching places, comma for comma - a pair that does not have a number is left
 * out, as the reference leaves it out, because a book that cannot say where it sits
 * in an arc cannot be placed in it.
 */
function readListsOf(xml: string): ReadListEntry[] {
  const entries: ReadListEntry[] = []

  const alternate = elementText(xml, 'AlternateSeries')
  if (alternate !== null) entries.push({ name: alternate, number: elementInt(xml, 'AlternateNumber') })

  const storyArcs = elementText(xml, 'StoryArc')
  if (storyArcs === null) return entries

  const names = storyArcs
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  const numbers = (elementText(xml, 'StoryArcNumber') ?? '')
    .split(',')
    .map((number) => number.trim())
    .map((number) => (/^[+-]?\d+$/.test(number) ? Number(number) : null))

  if (numbers.some((number) => number !== null)) {
    for (const [index, name] of names.entries()) {
      const number = numbers[index]
      if (number !== undefined && number !== null) entries.push({ name, number })
    }
    return entries
  }

  for (const name of names) entries.push({ name, number: null })
  return entries
}

/** The collections a `SeriesGroup` puts the series in, which may name several. */
function collectionsOf(xml: string): string[] {
  const group = elementText(xml, 'SeriesGroup')
  if (group === null) return []

  const collections: string[] = []
  for (const value of group.split(',')) {
    const name = value.trim()
    if (name !== '' && !collections.includes(name)) collections.push(name)
  }
  return collections
}

/**
 * What a ComicInfo document says about its book.
 *
 * A field the document does not carry is left out of the patch entirely, so a
 * hand-written document with three elements cannot wipe the rest of the book's
 * metadata.
 */
export function comicInfoBookPatch(xml: string): BookMetadataPatch {
  const patch: BookMetadataPatch = {}

  const title = elementText(xml, 'Title')
  if (title !== null) patch.title = title

  const summary = elementText(xml, 'Summary')
  if (summary !== null) patch.summary = summary

  const number = elementText(xml, 'Number')
  if (number !== null) patch.number = number

  const numberSort = elementFloat(xml, 'Number')
  if (numberSort !== null) patch.numberSort = numberSort

  const releaseDate = comicInfoReleaseDate(xml)
  if (releaseDate !== undefined) patch.releaseDate = releaseDate

  const authors = authorsOf(xml)
  if (authors.length > 0) patch.authors = authors

  const tags = tagsOf(xml)
  if (tags.length > 0) patch.tags = tags

  const links = linksOf(xml)
  if (links.length > 0) patch.links = links

  const isbn = validatedIsbn(elementText(xml, 'GTIN'))
  if (isbn !== null) patch.isbn = isbn

  const readLists = readListsOf(xml)
  if (readLists.length > 0) patch.readLists = readLists

  return patch
}

/**
 * What a ComicInfo document says about the series its book belongs to.
 *
 * `Series` is the name of the series; a document may also carry a `Volume`, and a
 * library can ask for it to be part of the title, which is how a collection of
 * loose files becomes one series per volume.
 */
export function comicInfoSeriesPatch(xml: string, options: { appendVolume?: boolean } = {}): SeriesMetadataPatch {
  const patch: SeriesMetadataPatch = {}

  const series = elementText(xml, 'Series')
  if (series !== null) {
    const volume = options.appendVolume === true ? elementInt(xml, 'Volume') : null
    // Volume 1 is the series itself; the reference only suffixes the others.
    const title = volume !== null && volume !== 1 ? `${series} (${volume})` : series
    patch.title = title
    patch.titleSort = title
  }

  const publisher = elementText(xml, 'Publisher')
  if (publisher !== null) patch.publisher = publisher

  const language = normalisedLanguage(elementText(xml, 'LanguageISO'))
  if (language !== null) patch.language = language

  const ageRating = COMIC_INFO_AGE_RATINGS.get((elementText(xml, 'AgeRating') ?? '').toLowerCase().replace(/\s+/g, ''))
  if (ageRating !== undefined) patch.ageRating = ageRating

  const readingDirection = COMIC_INFO_MANGA_DIRECTIONS.get((elementText(xml, 'Manga') ?? '').toLowerCase())
  if (readingDirection !== undefined) patch.readingDirection = readingDirection

  const genre = elementText(xml, 'Genre')
  if (genre !== null) {
    const genres: string[] = []
    for (const value of genre.split(',')) {
      const trimmed = value.trim()
      if (trimmed !== '' && !genres.includes(trimmed)) genres.push(trimmed)
    }
    if (genres.length > 0) patch.genres = genres
  }

  const count = elementInt(xml, 'Count')
  if (count !== null) patch.totalBookCount = count

  const collections = collectionsOf(xml)
  if (collections.length > 0) patch.collections = collections

  return patch
}
