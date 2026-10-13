import type { GroupCountDto, SearchConditionSeries } from '@/generated/openapi'
import type { SeriesGroups } from '@/types/ClientSettingsGlobal'

/** Every series, whatever it starts with. */
export const SYMBOL_ALL = 'ALL'
/** Every series that starts with none of the characters the navigation has a group for. */
export const SYMBOL_OTHER = '#'

/**
 * Lower case and without accents, which is how the server compares the start of a
 * title and how it names the groups it counts.
 */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** The characters of a group, folded, each once. */
function charactersOf(groups: SeriesGroups, symbol: string): string[] {
  return [...new Set((groups.groups[symbol] ?? []).map(fold))]
}

/** What the navigation offers, in order: everything, the rest, then each group. */
export function navigationSymbols(groups: SeriesGroups): string[] {
  return [SYMBOL_ALL, SYMBOL_OTHER, ...Object.keys(groups.groups)]
}

/**
 * The search condition that narrows series to a symbol of the navigation.
 *
 * `undefined` is no narrowing: that is `ALL`, and any symbol the grouping does not
 * have, so an address kept from another grouping lists everything rather than nothing.
 */
export function symbolCondition(
  symbol: string,
  groups: SeriesGroups,
): SearchConditionSeries | undefined {
  if (symbol === SYMBOL_OTHER) {
    const every = [
      ...new Set(Object.keys(groups.groups).flatMap((key) => charactersOf(groups, key))),
    ]
    return {
      allOf: every.map((value) => ({ titleSort: { operator: 'doesNotBeginWith', value } })),
    }
  }

  const characters = charactersOf(groups, symbol)
  if (characters.length === 0) return undefined
  return {
    anyOf: characters.map((value) => ({ titleSort: { operator: 'beginsWith', value } })),
  }
}

/**
 * How many series each symbol of the navigation leads to, from the server's count
 * per first character. `undefined` until the server has answered.
 */
export function symbolCounts(
  counts: GroupCountDto[] | undefined,
  groups: SeriesGroups,
): Record<string, number> | undefined {
  if (!counts) return undefined

  const byCharacter = new Map<string, number>()
  for (const { group, count } of counts) {
    const key = fold(group)
    byCharacter.set(key, (byCharacter.get(key) ?? 0) + count)
  }
  const total = counts.reduce((sum, { count }) => sum + count, 0)

  const result: Record<string, number> = {}
  let grouped = 0
  const counted = new Set<string>()
  for (const symbol of Object.keys(groups.groups)) {
    let sum = 0
    for (const character of charactersOf(groups, symbol)) {
      sum += byCharacter.get(character) ?? 0
      // A character listed under two groups is counted in both, and once in the rest.
      if (!counted.has(character)) {
        counted.add(character)
        grouped += byCharacter.get(character) ?? 0
      }
    }
    result[symbol] = sum
  }

  result[SYMBOL_ALL] = total
  result[SYMBOL_OTHER] = total - grouped
  return result
}
