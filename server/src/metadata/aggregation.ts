/**
 * A series' view of its books.
 *
 * `SeriesDto.booksMetadata` answers questions about a series that only its books
 * can answer: who worked on it, which tags it carries, when it first came out, and
 * what it is about. The reference keeps that in `book_metadata_aggregation`, one
 * row per series plus the union of the credits and tags, and recomputes it when a
 * book's metadata changes.
 */

import type { Kysely } from 'kysely'

import type { DB } from '../db/schema.js'
import type { Author } from './patches.js'

/** What a series' books agree on. */
export interface BookMetadataAggregation {
  authors: Author[]
  tags: string[]
  /** The earliest release date among the books, or null when none carries one. */
  releaseDate: string | null
  /** The summary of the earliest-numbered book that has one. */
  summary: string
  /** That book's number, which is what the client shows next to the summary. */
  summaryNumber: string
}

interface BookForAggregation {
  number: string
  numberSort: number
  summary: string
  releaseDate: string | null
  authors: readonly Author[]
  tags: readonly string[]
}

/** The union of the books' credits, in the order the books are read. */
function mergedAuthors(books: readonly BookForAggregation[]): Author[] {
  const authors: Author[] = []
  const seen = new Set<string>()
  for (const book of books) {
    for (const author of book.authors) {
      const key = `${author.role}\u0000${author.name}`
      if (seen.has(key)) continue
      seen.add(key)
      authors.push({ name: author.name, role: author.role })
    }
  }
  return authors
}

/** The union of the books' tags. */
function mergedTags(books: readonly BookForAggregation[]): string[] {
  const tags = new Set<string>()
  for (const book of books) for (const tag of book.tags) tags.add(tag)
  return [...tags]
}

/**
 * Aggregate what a series' books say about the series.
 *
 * The books arrive in reading order, which is what makes the summary choice
 * repeatable: the first book that has one wins, and a tie between two books with
 * the same number is broken by id.
 */
export function aggregateBookMetadata(books: readonly BookForAggregation[]): BookMetadataAggregation {
  const withSummary = books.find((book) => book.summary.trim() !== '')
  const releaseDates = books.map((book) => book.releaseDate).filter((date): date is string => date !== null)

  return {
    authors: mergedAuthors(books),
    tags: mergedTags(books),
    releaseDate:
      releaseDates.length === 0 ? null : releaseDates.reduce((earliest, date) => (date < earliest ? date : earliest)),
    summary: withSummary?.summary ?? '',
    summaryNumber: withSummary?.number ?? '',
  }
}

/** Compare as sets: the order rows come back in is not the order they were written. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function sameAuthors(left: readonly Author[], right: readonly Author[]): boolean {
  return sameSet(
    left.map((author) => `${author.role}\u0000${author.name}`),
    right.map((author) => `${author.role}\u0000${author.name}`),
  )
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return sameSet(left, right)
}

/**
 * Recompute and store the aggregation of a series.
 *
 * Returns whether anything changed, so a caller can report it and so nothing is
 * rewritten - and no timestamp moved - when a book is analysed again.
 */
export async function aggregateSeriesMetadata(db: Kysely<DB>, seriesId: string): Promise<boolean> {
  const bookRows = await db
    .selectFrom('books')
    .innerJoin('book_metadata', 'book_metadata.book_id', 'books.id')
    .select([
      'books.id',
      'book_metadata.number',
      'book_metadata.number_sort',
      'book_metadata.summary',
      'book_metadata.release_date',
    ])
    .where('books.series_id', '=', seriesId)
    .where('books.deleted_date', 'is', null)
    .orderBy('book_metadata.number_sort')
    .orderBy('books.id')
    .execute()

  const bookIds = bookRows.map((row) => row.id)
  const [authorRows, tagRows] = await Promise.all([
    bookIds.length === 0
      ? []
      : db
          .selectFrom('book_metadata_author')
          .select(['book_id', 'name', 'role'])
          .where('book_id', 'in', bookIds)
          .execute(),
    bookIds.length === 0
      ? []
      : db.selectFrom('book_metadata_tag').select(['book_id', 'tag']).where('book_id', 'in', bookIds).execute(),
  ])

  const authorsByBook = new Map<string, Author[]>()
  for (const row of authorRows) {
    const list = authorsByBook.get(row.book_id)
    if (list) list.push({ name: row.name, role: row.role })
    else authorsByBook.set(row.book_id, [{ name: row.name, role: row.role }])
  }
  const tagsByBook = new Map<string, string[]>()
  for (const row of tagRows) {
    const list = tagsByBook.get(row.book_id)
    if (list) list.push(row.tag)
    else tagsByBook.set(row.book_id, [row.tag])
  }

  const aggregation = aggregateBookMetadata(
    bookRows.map((row) => ({
      number: row.number,
      numberSort: row.number_sort,
      summary: row.summary,
      releaseDate: row.release_date,
      authors: authorsByBook.get(row.id) ?? [],
      tags: tagsByBook.get(row.id) ?? [],
    })),
  )

  const current = await db
    .selectFrom('book_metadata_aggregation')
    .selectAll()
    .where('series_id', '=', seriesId)
    .executeTakeFirst()
  const currentAuthors = await db
    .selectFrom('book_metadata_aggregation_author')
    .select(['name', 'role'])
    .where('series_id', '=', seriesId)
    .execute()
  const currentTags = await db
    .selectFrom('book_metadata_aggregation_tag')
    .select('tag')
    .where('series_id', '=', seriesId)
    .execute()

  const authors = currentAuthors.map((row) => ({ name: row.name, role: row.role }))
  const tags = currentTags.map((row) => row.tag)
  const unchanged =
    current !== undefined &&
    current.summary === aggregation.summary &&
    current.summary_number === aggregation.summaryNumber &&
    current.release_date === aggregation.releaseDate &&
    sameAuthors(authors, aggregation.authors) &&
    sameTags(tags, aggregation.tags)
  if (unchanged) return false

  const now = new Date().toISOString()
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('book_metadata_aggregation')
      .values({
        series_id: seriesId,
        summary: aggregation.summary,
        summary_number: aggregation.summaryNumber,
        release_date: aggregation.releaseDate,
        created_date: now,
        last_modified_date: now,
      })
      .onConflict((oc) =>
        oc.column('series_id').doUpdateSet({
          summary: aggregation.summary,
          summary_number: aggregation.summaryNumber,
          release_date: aggregation.releaseDate,
          last_modified_date: now,
        }),
      )
      .execute()

    await trx.deleteFrom('book_metadata_aggregation_author').where('series_id', '=', seriesId).execute()
    if (aggregation.authors.length > 0) {
      await trx
        .insertInto('book_metadata_aggregation_author')
        .values(aggregation.authors.map((author) => ({ series_id: seriesId, name: author.name, role: author.role })))
        .execute()
    }

    await trx.deleteFrom('book_metadata_aggregation_tag').where('series_id', '=', seriesId).execute()
    if (aggregation.tags.length > 0) {
      await trx
        .insertInto('book_metadata_aggregation_tag')
        .values(aggregation.tags.map((tag) => ({ series_id: seriesId, tag })))
        .execute()
    }
  })

  return true
}
