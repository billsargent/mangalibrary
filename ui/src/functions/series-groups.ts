import {
  ClientSettingGlobal,
  SERIES_GROUPS,
  SERIES_GROUPS_ALPHA,
  type SeriesGroups,
  type SeriesGroupsName,
  SeriesGroupsNames,
} from '@/types/ClientSettingsGlobal'
import type { ClientSettingDto, ClientSettingGlobalUpdateDto } from '@/generated/openapi'

/**
 * The series grouping the server is set to.
 *
 * Only the name is trusted: the groups themselves come from this build, so a
 * stored value from an older version cannot leave the navigation with a table
 * that no longer matches. Anything unreadable is the alphabet.
 */
export function parseSeriesGroups(
  raw: Record<string, Pick<ClientSettingDto, 'value'>> | undefined,
): SeriesGroups {
  const stored = raw?.[ClientSettingGlobal.SeriesGroups]?.value
  if (!stored) return SERIES_GROUPS_ALPHA
  try {
    const name = (JSON.parse(stored) as { name?: unknown } | null)?.name
    return (SeriesGroupsNames as readonly unknown[]).includes(name)
      ? SERIES_GROUPS[name as SeriesGroupsName]
      : SERIES_GROUPS_ALPHA
  } catch {
    return SERIES_GROUPS_ALPHA
  }
}

/** What is stored to set the series grouping, in the form the previous interface stored. */
export function seriesGroupsUpdate(
  name: SeriesGroupsName,
): Record<string, ClientSettingGlobalUpdateDto> {
  return {
    [ClientSettingGlobal.SeriesGroups]: {
      value: JSON.stringify(SERIES_GROUPS[name]),
      // Grouping is only of use to someone who can see series.
      allowUnauthorized: false,
    },
  }
}
