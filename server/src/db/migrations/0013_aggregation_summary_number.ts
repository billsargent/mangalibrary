import type { Migration } from '../migrate.js'

/**
 * Bring the book metadata aggregation in line with the reference.
 *
 * The aggregation is what `SeriesDto.booksMetadata` shows: the union of a series'
 * credits and tags, its earliest release date, and the summary of its
 * earliest-numbered book. The table was created from an older shape of Komga, which
 * also mirrored series-level fields (`title`, `publisher`, `language`, `ageRating`,
 * `status`, `readingDirection`, `titleSort`) that neither the current schema nor the
 * published DTO has; nothing computed them, so they were always empty. Drop them and
 * add the summary's book number, which the DTO carries and the schema did not keep.
 */
export const migration0013AggregationSummaryNumber: Migration = {
  id: '0013_aggregation_summary_number',
  up: async (db) => {
    await db.schema
      .alterTable('book_metadata_aggregation')
      .addColumn('summary_number', 'text', (col) => col.notNull().defaultTo(''))
      .execute()

    for (const column of [
      'title',
      'title_sort',
      'publisher',
      'language',
      'age_rating',
      'status',
      'reading_direction',
    ]) {
      await db.schema.alterTable('book_metadata_aggregation').dropColumn(column).execute()
    }
  },
}
