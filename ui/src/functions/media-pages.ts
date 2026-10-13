import type { BookSearch, SearchConditionBook } from '@/generated/openapi'
import { MediaStatus } from '@/types/MediaStatus'

/** The media statuses the analysis page can show. */
export const ANALYSIS_STATUSES = [MediaStatus.Error, MediaStatus.Unsupported] as const
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number]

const anyOf = (conditions: SearchConditionBook[]): SearchConditionBook => ({ anyOf: conditions })

/**
 * The books whose analysis did not succeed: any of the chosen statuses, in any of
 * the chosen libraries. No library chosen means every library.
 *
 * No status chosen is no search at all - there is nothing to look for - and is
 * given back as `null` so the page asks the server nothing.
 */
export function analysisSearch(
  statuses: readonly AnalysisStatus[],
  libraryIds: readonly string[],
): BookSearch | null {
  if (statuses.length === 0) return null

  const conditions: SearchConditionBook[] = [
    anyOf(statuses.map((status) => ({ mediaStatus: { operator: 'is', value: status } }))),
  ]
  if (libraryIds.length > 0) {
    conditions.push(anyOf(libraryIds.map((id) => ({ libraryId: { operator: 'is', value: id } }))))
  }
  return { condition: { allOf: conditions } }
}

/**
 * The books that could have a poster and have none chosen: analysed without
 * trouble, and with no selected thumbnail.
 */
export function missingPostersSearch(): BookSearch {
  return {
    condition: {
      allOf: [
        { mediaStatus: { operator: 'is', value: MediaStatus.Ready } },
        { poster: { operator: 'isNot', value: { selected: true } } },
      ],
    },
  }
}
