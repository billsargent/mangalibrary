import { sql, type Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import {
  emptyBookExtras,
  emptySeriesExtras,
  toBookDto,
  toBookMetadataAggregationDto,
  toBookMetadataDto,
  toMediaDto,
  toReadProgressDto,
  toSeriesDto,
  toSeriesMetadataDto,
  type AlternateTitleDto,
  type AuthorDto,
  type BookDto,
  type BookExtras,
  type BookMetadataAggregationDto,
  type BookMetadataAggregationRow,
  type BookMetadataRow,
  type BookRow,
  type MediaRow,
  type ReadProgressRow,
  type SeriesCounts,
  type SeriesDto,
  type SeriesExtras,
  type SeriesMetadataRow,
  type SeriesRow,
  type WebLinkDto,
} from './content-dto.js'

/**
 * Bulk loaders for the content endpoints.
 *
 * Everything here takes a *list* of ids and issues one query per relation, so a
 * page of 20 series costs a fixed number of queries rather than 20 per relation.
 *
 * List-valued metadata is returned in a deterministic order (alphabetically by
 * its label), because the database gives no meaningful ordering of its own.
 */

export async function loadSeriesExtras(
  db: Kysely<DB>,
  seriesIds: readonly string[],
): Promise<Map<string, SeriesExtras>> {
  const extras = new Map<string, SeriesExtras>()
  if (seriesIds.length === 0) return extras
  for (const id of seriesIds) extras.set(id, emptySeriesExtras())

  const [tags, genres, links, alternateTitles, sharing] = await Promise.all([
    db
      .selectFrom('series_metadata_tag')
      .select(['series_id', 'tag'])
      .where('series_id', 'in', seriesIds)
      .orderBy('tag')
      .execute(),
    db
      .selectFrom('series_metadata_genre')
      .select(['series_id', 'genre'])
      .where('series_id', 'in', seriesIds)
      .orderBy('genre')
      .execute(),
    db
      .selectFrom('series_metadata_link')
      .select(['series_id', 'label', 'url'])
      .where('series_id', 'in', seriesIds)
      .orderBy('label')
      .orderBy('url')
      .execute(),
    db
      .selectFrom('series_metadata_alternate_title')
      .select(['series_id', 'title', 'label'])
      .where('series_id', 'in', seriesIds)
      .orderBy('label')
      .orderBy('title')
      .execute(),
    db
      .selectFrom('series_metadata_sharing')
      .select(['series_id', 'label'])
      .where('series_id', 'in', seriesIds)
      .orderBy('label')
      .execute(),
  ])

  for (const row of tags) extras.get(row.series_id)?.tags.push(row.tag)
  for (const row of genres) extras.get(row.series_id)?.genres.push(row.genre)
  for (const row of links) extras.get(row.series_id)?.links.push({ label: row.label, url: row.url })
  for (const row of alternateTitles) {
    extras.get(row.series_id)?.alternateTitles.push({ label: row.label, title: row.title })
  }
  for (const row of sharing) extras.get(row.series_id)?.sharingLabels.push(row.label)

  return extras
}

/**
 * Per-series reading counts for one user.
 *
 * Counts are derived from the books themselves rather than from the `books`
 * counter on the series row, so they stay correct for a series whose counter has
 * not been recomputed yet.
 */
export async function loadSeriesCounts(
  db: Kysely<DB>,
  seriesIds: readonly string[],
  userId: string,
): Promise<Map<string, SeriesCounts>> {
  const counts = new Map<string, SeriesCounts>()
  if (seriesIds.length === 0) return counts

  const rows = await db
    .selectFrom('books')
    .leftJoin('read_progress', (join) =>
      join.onRef('read_progress.book_id', '=', 'books.id').on('read_progress.user_id', '=', userId),
    )
    .select([
      'books.series_id',
      sql<number>`count(*)`.as('books_count'),
      sql<number>`coalesce(sum(case when read_progress.completed = 1 then 1 else 0 end), 0)`.as('read_count'),
      sql<number>`coalesce(sum(case when read_progress.book_id is not null and read_progress.completed = 0 then 1 else 0 end), 0)`.as(
        'in_progress_count',
      ),
    ])
    .where('books.series_id', 'in', seriesIds)
    .where('books.deleted_date', 'is', null)
    .groupBy('books.series_id')
    .execute()

  for (const row of rows) {
    counts.set(row.series_id, {
      booksCount: Number(row.books_count),
      booksReadCount: Number(row.read_count),
      booksInProgressCount: Number(row.in_progress_count),
    })
  }
  return counts
}

async function loadAggregation(
  db: Kysely<DB>,
  seriesIds: readonly string[],
): Promise<Map<string, BookMetadataAggregationRow>> {
  const rows = new Map<string, BookMetadataAggregationRow>()
  if (seriesIds.length === 0) return rows
  const result = await db
    .selectFrom('book_metadata_aggregation')
    .selectAll()
    .where('series_id', 'in', seriesIds)
    .execute()
  for (const row of result) rows.set(row.series_id, row as unknown as BookMetadataAggregationRow)
  return rows
}

async function loadSeriesMetadata(
  db: Kysely<DB>,
  seriesIds: readonly string[],
): Promise<Map<string, SeriesMetadataRow>> {
  const rows = new Map<string, SeriesMetadataRow>()
  if (seriesIds.length === 0) return rows
  const result = await db.selectFrom('series_metadata').selectAll().where('series_id', 'in', seriesIds).execute()
  for (const row of result) rows.set(row.series_id, row as unknown as SeriesMetadataRow)
  return rows
}

/** Series authors/tags as shown in `SeriesDto.booksMetadata`. */
async function loadAggregationExtras(
  db: Kysely<DB>,
  seriesIds: readonly string[],
): Promise<Map<string, { authors: AuthorDto[]; tags: string[] }>> {
  const extras = new Map<string, { authors: AuthorDto[]; tags: string[] }>()
  if (seriesIds.length === 0) return extras
  for (const id of seriesIds) extras.set(id, { authors: [], tags: [] })

  const [authors, tags] = await Promise.all([
    db
      .selectFrom('book_metadata_aggregation_author')
      .select(['series_id', 'name', 'role'])
      .where('series_id', 'in', seriesIds)
      .orderBy('name')
      .orderBy('role')
      .execute(),
    db
      .selectFrom('book_metadata_aggregation_tag')
      .select(['series_id', 'tag'])
      .where('series_id', 'in', seriesIds)
      .orderBy('tag')
      .execute(),
  ])

  for (const row of authors) extras.get(row.series_id)?.authors.push({ name: row.name, role: row.role })
  for (const row of tags) extras.get(row.series_id)?.tags.push(row.tag)
  return extras
}

export async function loadBookExtras(db: Kysely<DB>, bookIds: readonly string[]): Promise<Map<string, BookExtras>> {
  const extras = new Map<string, BookExtras>()
  if (bookIds.length === 0) return extras
  for (const id of bookIds) extras.set(id, emptyBookExtras())

  const [authors, tags, links] = await Promise.all([
    db
      .selectFrom('book_metadata_author')
      .select(['book_id', 'name', 'role'])
      .where('book_id', 'in', bookIds)
      .orderBy('name')
      .orderBy('role')
      .execute(),
    db
      .selectFrom('book_metadata_tag')
      .select(['book_id', 'tag'])
      .where('book_id', 'in', bookIds)
      .orderBy('tag')
      .execute(),
    db
      .selectFrom('book_metadata_link')
      .select(['book_id', 'label', 'url'])
      .where('book_id', 'in', bookIds)
      .orderBy('label')
      .orderBy('url')
      .execute(),
  ])

  for (const row of authors) extras.get(row.book_id)?.authors.push({ name: row.name, role: row.role })
  for (const row of tags) extras.get(row.book_id)?.tags.push(row.tag)
  for (const row of links) extras.get(row.book_id)?.links.push({ label: row.label, url: row.url })
  return extras
}

async function loadBookMetadata(
  db: Kysely<DB>,
  bookIds: readonly string[],
): Promise<Map<string, BookMetadataRow>> {
  const rows = new Map<string, BookMetadataRow>()
  if (bookIds.length === 0) return rows
  const result = await db.selectFrom('book_metadata').selectAll().where('book_id', 'in', bookIds).execute()
  for (const row of result) rows.set(row.book_id, row as unknown as BookMetadataRow)
  return rows
}

async function loadMedia(db: Kysely<DB>, bookIds: readonly string[]): Promise<Map<string, MediaRow>> {
  const rows = new Map<string, MediaRow>()
  if (bookIds.length === 0) return rows
  const result = await db.selectFrom('media').selectAll().where('book_id', 'in', bookIds).execute()
  for (const row of result) rows.set(row.book_id, row as unknown as MediaRow)
  return rows
}

async function loadProgress(
  db: Kysely<DB>,
  bookIds: readonly string[],
  userId: string,
): Promise<Map<string, ReadProgressRow>> {
  const rows = new Map<string, ReadProgressRow>()
  if (bookIds.length === 0) return rows
  const result = await db
    .selectFrom('read_progress')
    .selectAll()
    .where('book_id', 'in', bookIds)
    .where('user_id', '=', userId)
    .execute()
  for (const row of result) rows.set(row.book_id, row as unknown as ReadProgressRow)
  return rows
}

/** Assemble complete series DTOs, preserving the order of `rows`. */
export async function buildSeriesDtos(
  db: Kysely<DB>,
  rows: readonly SeriesRow[],
  userId: string,
): Promise<SeriesDto[]> {
  const ids = rows.map((row) => row.id)
  const [metadata, extras, aggregation, aggregationExtras, counts] = await Promise.all([
    loadSeriesMetadata(db, ids),
    loadSeriesExtras(db, ids),
    loadAggregation(db, ids),
    loadAggregationExtras(db, ids),
    loadSeriesCounts(db, ids, userId),
  ])

  return rows.map((row) => {
    const meta = metadata.get(row.id)
    if (!meta) throw new Error(`series ${row.id} has no metadata row`)
    const aggregates = aggregationExtras.get(row.id) ?? { authors: [], tags: [] }
    return toSeriesDto(
      row,
      meta,
      toBookMetadataAggregationDto(aggregation.get(row.id), aggregates.authors, aggregates.tags),
      counts.get(row.id) ?? { booksCount: 0, booksReadCount: 0, booksInProgressCount: 0 },
      extras.get(row.id) ?? emptySeriesExtras(),
    )
  })
}

/** Assemble complete book DTOs, preserving the order of `rows`. */
export async function buildBookDtos(db: Kysely<DB>, rows: readonly BookRow[], userId: string): Promise<BookDto[]> {
  const ids = rows.map((row) => row.id)
  const seriesIds = [...new Set(rows.map((row) => row.series_id))]
  const [metadata, extras, media, progress, series] = await Promise.all([
    loadBookMetadata(db, ids),
    loadBookExtras(db, ids),
    loadMedia(db, ids),
    loadProgress(db, ids, userId),
    seriesIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom('series')
          .select(['id', 'name'])
          .where('id', 'in', seriesIds)
          .execute(),
  ])

  const titles = new Map(series.map((row) => [row.id, row.name]))

  return rows.map((row) => {
    const meta = metadata.get(row.id)
    if (!meta) throw new Error(`book ${row.id} has no metadata row`)
    return toBookDto(
      row,
      titles.get(row.series_id) ?? '',
      toBookMetadataDto(meta, extras.get(row.id) ?? emptyBookExtras()),
      toMediaDto(media.get(row.id)),
      toReadProgressDto(progress.get(row.id)),
    )
  })
}

/** Series sharing labels, needed when writing a series and re-checking access. */
export async function seriesSharingLabels(db: Kysely<DB>, seriesId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('series_metadata_sharing')
    .select('label')
    .where('series_id', '=', seriesId)
    .execute()
  return rows.map((row) => row.label)
}

export type { AlternateTitleDto, WebLinkDto }
