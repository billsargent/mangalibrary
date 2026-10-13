/**
 * A series' metadata, read out of its books.
 *
 * A series has no file of its own, so almost everything known about it comes from
 * its books: their `ComicInfo.xml` documents name the series, its publisher, its
 * language, its genres and its reading direction. Each book offers a patch, and the
 * patches are folded into one - the value most of them agree on, the highest age
 * rating, the union of the genres - which is what the reference does before it
 * applies the result to the series.
 *
 * A value a user has locked survives, as it does for a book.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'

import { bookFilePath, seriesFolderPath, type SeriesFolderRecord } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { onThread } from '../threads/index.js'
import { addSeriesToCollection } from '../organisation/membership.js'
import { aggregateSeriesMetadata } from './aggregation.js'
import { comicInfoSeriesPatch } from './comicinfo.js'
import { epubMetadata } from './epub.js'
import {
  applySeriesPatches,
  isEmptySeriesUpdate,
  type SeriesMetadataPatch,
  type SeriesMetadataState,
} from './patches.js'
import { mylarSeriesPatch } from './sidecar.js'

/** The sidecar Mylar writes into a series folder. */
export const MYLAR_SIDECAR = 'series.json'

/** What a series folder's sidecar says, or null when there is none or it is unusable. */
async function sidecarPatch(record: SeriesFolderRecord): Promise<SeriesMetadataPatch | null> {
  const folder = await seriesFolderPath(record)
  if (folder === null) return null

  const content = await readFile(join(folder, MYLAR_SIDECAR), 'utf8').catch(() => null)
  return content === null ? null : mylarSeriesPatch(content)
}

/** What refreshing a series did. */
export interface SeriesRefreshResult {
  status: 'changed' | 'unchanged' | 'skipped' | 'failed'
  /** The series fields written, named as the API names them. */
  changed: string[]
  /** Whether the aggregation of its books was rewritten. */
  aggregationChanged: boolean
  /** The collections the series was put in, by name. */
  collections: string[]
  reason: string | null
}

const VALUE_NAMES: Record<string, string> = {
  status: 'status',
  title: 'title',
  title_sort: 'titleSort',
  summary: 'summary',
  reading_direction: 'readingDirection',
  age_rating: 'ageRating',
  publisher: 'publisher',
  language: 'language',
  total_book_count: 'totalBookCount',
}

/**
 * The value most of the patches carry.
 *
 * A tie goes to the value seen first, which - because the patches arrive in
 * reading order - is the earliest book's. The reference leaves that order to the
 * database; here it is the series' own order, so the same library always aggregates
 * the same way.
 */
function mostFrequent(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value === undefined) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  let best: string | undefined
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** Fold what the books say into one patch for the series. */
export function aggregateSeriesPatches(patches: readonly SeriesMetadataPatch[]): SeriesMetadataPatch {
  const aggregated: SeriesMetadataPatch = {}

  const title = mostFrequent(patches.map((patch) => patch.title))
  if (title !== undefined) aggregated.title = title
  const titleSort = mostFrequent(patches.map((patch) => patch.titleSort))
  if (titleSort !== undefined) aggregated.titleSort = titleSort
  const publisher = mostFrequent(patches.map((patch) => patch.publisher))
  if (publisher !== undefined) aggregated.publisher = publisher
  const language = mostFrequent(patches.map((patch) => patch.language))
  if (language !== undefined) aggregated.language = language
  const readingDirection = mostFrequent(patches.map((patch) => patch.readingDirection))
  if (readingDirection !== undefined) aggregated.readingDirection = readingDirection

  // An age rating is a floor: a series with one mature book is a mature series.
  const ageRatings = patches.map((patch) => patch.ageRating).filter((value): value is number => value !== undefined)
  if (ageRatings.length > 0) aggregated.ageRating = Math.max(...ageRatings)

  const counts = patches.map((patch) => patch.totalBookCount).filter((value): value is number => value !== undefined)
  if (counts.length > 0) aggregated.totalBookCount = Math.max(...counts)

  const genres: string[] = []
  for (const patch of patches) {
    for (const genre of patch.genres ?? []) if (!genres.includes(genre)) genres.push(genre)
  }
  if (genres.length > 0) aggregated.genres = genres

  return aggregated
}

async function seriesMetadataState(db: Kysely<DB>, seriesId: string): Promise<SeriesMetadataState | null> {
  const row = await db.selectFrom('series_metadata').selectAll().where('series_id', '=', seriesId).executeTakeFirst()
  if (!row) return null

  const genres = await db
    .selectFrom('series_metadata_genre')
    .select('genre')
    .where('series_id', '=', seriesId)
    .execute()

  return {
    status: row.status,
    title: row.title,
    titleSort: row.title_sort,
    summary: row.summary,
    readingDirection: row.reading_direction,
    ageRating: row.age_rating,
    publisher: row.publisher,
    language: row.language,
    totalBookCount: row.total_book_count,
    genres: genres.map((genre) => genre.genre),
    locks: {
      status: row.status_lock === 1,
      title: row.title_lock === 1,
      titleSort: row.title_sort_lock === 1,
      summary: row.summary_lock === 1,
      readingDirection: row.reading_direction_lock === 1,
      ageRating: row.age_rating_lock === 1,
      publisher: row.publisher_lock === 1,
      language: row.language_lock === 1,
      totalBookCount: row.total_book_count_lock === 1,
      genres: row.genres_lock === 1,
    },
  }
}

async function writeSeriesUpdate(
  db: Kysely<DB>,
  seriesId: string,
  update: { values: Record<string, unknown>; genres?: readonly string[] },
  now: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (Object.keys(update.values).length > 0) {
      await trx
        .updateTable('series_metadata')
        .set({ ...update.values, last_modified_date: now } as never)
        .where('series_id', '=', seriesId)
        .execute()
    }

    if (update.genres !== undefined) {
      await trx.deleteFrom('series_metadata_genre').where('series_id', '=', seriesId).execute()
      if (update.genres.length > 0) {
        await trx
          .insertInto('series_metadata_genre')
          .values(update.genres.map((genre) => ({ series_id: seriesId, genre })))
          .execute()
      }
    }
  })
}

/**
 * Read a series' books and apply what they say about it, then recompute the
 * aggregation the clients see as `booksMetadata`.
 *
 * A book whose file cannot be read is left out rather than failing the series: one
 * damaged archive should not stop the others from being read.
 */
export async function refreshSeriesMetadata(db: Kysely<DB>, seriesId: string): Promise<SeriesRefreshResult> {
  const series = await db
    .selectFrom('series')
    .select(['id', 'library_id', 'name', 'url', 'oneshot'])
    .where('id', '=', seriesId)
    .executeTakeFirst()
  if (!series) throw new Error(`series ${seriesId} does not exist`)

  const library = await db
    .selectFrom('libraries')
    .select([
      'root',
      'import_comic_info_series',
      'import_comic_info_series_append_volume',
      'import_epub_series',
      'import_mylar_series',
      'import_comic_info_collection',
    ])
    .where('id', '=', series.library_id)
    .executeTakeFirst()
  if (!library) throw new Error(`library ${series.library_id} does not exist`)

  // A series is described by its books and by its own sidecars, and a oneshot series
  // is its single book whatever the settings say - which is what the reference does.
  // The switches are independent, as they are in the reference: a library can take
  // the collections its books name without taking what they say about the series.
  const readsComicInfo = library.import_comic_info_series === 1
  const readsCollections = library.import_comic_info_collection === 1
  const readsEpub = library.import_epub_series === 1
  const readsBooks = readsComicInfo || readsCollections || readsEpub
  const readsSidecar = library.import_mylar_series === 1 && series.oneshot !== 1
  const isOneshot = series.oneshot === 1

  if (!readsBooks && !readsSidecar && !isOneshot) {
    return {
      status: 'skipped',
      changed: [],
      aggregationChanged: false,
      collections: [],
      reason: 'the library does not import series metadata',
    }
  }

  const books = await db
    .selectFrom('books')
    .innerJoin('libraries', 'libraries.id', 'books.library_id')
    .select(['books.id', 'books.name', 'books.url', 'libraries.root'])
    .where('books.series_id', '=', seriesId)
    .where('books.deleted_date', 'is', null)
    .orderBy('books.number')
    .orderBy('books.id')
    .execute()

  const comicPatches: SeriesMetadataPatch[] = []
  const epubPatches: SeriesMetadataPatch[] = []
  const named = new Set<string>()
  let failed = false
  for (const book of readsBooks ? books : []) {
    const path = await bookFilePath({
      libraryId: series.library_id,
      seriesId,
      name: book.name,
      url: book.url,
      root: book.root,
    })
    if (path === null) continue

    const read = await onThread('documents', { path })
    if (read.status === 'failed') failed = true
    if (read.status !== 'ok') continue

    if ((readsComicInfo || readsCollections) && read.documents.comicInfo !== null) {
      const patch = comicInfoSeriesPatch(read.documents.comicInfo, {
        appendVolume: library.import_comic_info_series_append_volume === 1,
      })
      if (readsComicInfo) comicPatches.push(patch)
      if (readsCollections) for (const name of patch.collections ?? []) named.add(name)
    }
    if (readsEpub && read.documents.packageDocument !== null) {
      // An EPUB states its own collection and never appends a volume, so the
      // library's append setting does not apply to it.
      epubPatches.push(epubMetadata(read.documents.packageDocument).series)
    }
  }

  const state = await seriesMetadataState(db, seriesId)
  if (state === null) {
    return {
      status: 'skipped',
      changed: [],
      aggregationChanged: false,
      collections: [],
      reason: 'the series has no metadata row',
    }
  }

  // The books have said what they can. What follows speaks for the series itself: a
  // Mylar sidecar names the collection, and a oneshot series is its single book.
  // That is the order the reference's providers run in, so a source that speaks for
  // the series wins over what its books say.
  const later: SeriesMetadataPatch[] = []

  if (readsSidecar) {
    const sidecar = await sidecarPatch({
      libraryId: series.library_id,
      name: series.name,
      url: series.url,
      root: library.root,
    })
    if (sidecar !== null) later.push(sidecar)
  }

  if (series.oneshot === 1) {
    const first = books[0]
    const metadata =
      first === undefined
        ? undefined
        : await db
            .selectFrom('book_metadata')
            .select(['title', 'summary'])
            .where('book_id', '=', first.id)
            .executeTakeFirst()
    if (metadata) {
      later.push({
        title: metadata.title,
        titleSort: metadata.title,
        summary: metadata.summary,
        status: 'ENDED',
        totalBookCount: 1,
      })
    }
  }

  // Each kind of document is folded on its own and applied in turn, as the reference
  // runs one provider after another: in a series of comics and EPUBs, what most of
  // the comics say is not outvoted by the EPUBs, it is followed by them.
  const update = applySeriesPatches(state, [
    aggregateSeriesPatches(comicPatches),
    aggregateSeriesPatches(epubPatches),
    ...later,
  ])
  let changed: string[] = []

  if (!isEmptySeriesUpdate(update)) {
    const now = new Date().toISOString()
    await writeSeriesUpdate(db, seriesId, update, now)
    changed = Object.keys(update.values).map((column) => VALUE_NAMES[column] ?? column)
    if (update.genres !== undefined) changed.push('genres')
  }

  // Collections are organisation rather than metadata, so they are gathered from
  // every book's patch rather than from the aggregated one - a series belongs to
  // every group its books name - and they are honoured whether or not a field was
  // written.
  const collections: string[] = []
  for (const name of named) {
    const outcome = await addSeriesToCollection(db, name, seriesId)
    if (outcome !== 'present') collections.push(name)
  }

  const aggregationChanged = await aggregateSeriesMetadata(db, seriesId)

  if (changed.length > 0 || aggregationChanged || collections.length > 0) {
    return { status: 'changed', changed, aggregationChanged, collections, reason: null }
  }
  if (failed) {
    return {
      status: 'failed',
      changed: [],
      aggregationChanged: false,
      collections: [],
      reason: 'a book could not be read',
    }
  }
  return { status: 'unchanged', changed: [], aggregationChanged: false, collections: [], reason: null }
}
