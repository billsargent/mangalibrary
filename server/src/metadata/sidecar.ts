/**
 * Mylar's `series.json`, a sidecar a collection manager writes next to the books.
 *
 * It is a JSON document with a `metadata` object, and it is the only thing that
 * tells a library what a series is called when its books carry nothing: the name,
 * the publisher, the year, the volume, a description, a status and how many issues
 * the run has.
 *
 * A malformed file is not an error worth failing a scan over: the sidecar is a
 * convenience, so anything unreadable simply contributes nothing.
 */

import type { SeriesMetadataPatch } from './patches.js'

/** The `AgeRating` values Mylar writes, as the ages the metadata tables hold. */
export const MYLAR_AGE_RATINGS: ReadonlyMap<string, number> = new Map([
  ['all', 0],
  ['9+', 9],
  ['12+', 12],
  ['15+', 15],
  ['17+', 17],
  ['adult', 18],
])

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * What a sidecar says about its series, or null when it says nothing usable.
 *
 * The title is the collection's name, with the year appended once the collection
 * has more than one volume, because that is how a run of separate volumes is told
 * apart from the series as a whole - which is what the reference does.
 */
export function mylarSeriesPatch(json: string): SeriesMetadataPatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const metadata = object(object(parsed)?.metadata)
  if (metadata === null) return null

  const patch: SeriesMetadataPatch = {}

  const name = text(metadata.name)
  if (name !== null) {
    const volume = int(metadata.volume)
    const year = int(metadata.year)
    const title = volume !== null && volume !== 1 && year !== null ? `${name} (${year})` : name
    patch.title = title
    patch.titleSort = title
  }

  const status = text(metadata.status)?.toLowerCase()
  if (status === 'ended') patch.status = 'ENDED'
  else if (status === 'continuing') patch.status = 'ONGOING'

  const summary = text(metadata.description_formatted) ?? text(metadata.description_text)
  if (summary !== null) patch.summary = summary

  const publisher = text(metadata.publisher)
  if (publisher !== null) patch.publisher = publisher

  const totalIssues = int(metadata.total_issues)
  if (totalIssues !== null) patch.totalBookCount = totalIssues

  const ageRating = MYLAR_AGE_RATINGS.get((text(metadata.age_rating) ?? '').toLowerCase())
  if (ageRating !== undefined) patch.ageRating = ageRating

  return patch
}
