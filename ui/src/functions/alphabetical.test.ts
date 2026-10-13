import { describe, expect, test } from 'vitest'
import { navigationSymbols, symbolCondition, symbolCounts } from './alphabetical'
import { SERIES_GROUPS_ALPHA, SERIES_GROUPS_JAPANESE } from '@/types/ClientSettingsGlobal'

describe('navigationSymbols', () => {
  test('offers everything, the rest, then each group in order', () => {
    const symbols = navigationSymbols(SERIES_GROUPS_ALPHA)
    expect(symbols.slice(0, 4)).toEqual(['ALL', '#', 'A', 'B'])
    expect(symbols).toHaveLength(28)
    expect(navigationSymbols(SERIES_GROUPS_JAPANESE).slice(0, 3)).toEqual(['ALL', '#', 'あ'])
  })
})

describe('symbolCondition', () => {
  test('does not narrow for everything', () => {
    expect(symbolCondition('ALL', SERIES_GROUPS_ALPHA)).toBeUndefined()
  })

  test('narrows to titles that begin with a letter', () => {
    expect(symbolCondition('B', SERIES_GROUPS_ALPHA)).toEqual({
      anyOf: [{ titleSort: { operator: 'beginsWith', value: 'b' } }],
    })
  })

  test('takes every character of a group, once the server would see them as the same', () => {
    // か and が are one character to a comparison that drops accents; カ and ガ another.
    expect(symbolCondition('か', SERIES_GROUPS_JAPANESE)).toEqual({
      anyOf: [
        { titleSort: { operator: 'beginsWith', value: 'か' } },
        { titleSort: { operator: 'beginsWith', value: 'カ' } },
      ],
    })
  })

  test('narrows the rest to titles that begin with none of the letters', () => {
    const condition = symbolCondition('#', SERIES_GROUPS_ALPHA) as { allOf: unknown[] }
    expect(condition.allOf).toHaveLength(26)
    expect(condition.allOf[0]).toEqual({ titleSort: { operator: 'doesNotBeginWith', value: 'a' } })
  })

  test('does not narrow for a symbol the grouping does not have', () => {
    expect(symbolCondition('あ', SERIES_GROUPS_ALPHA)).toBeUndefined()
    expect(symbolCondition('', SERIES_GROUPS_ALPHA)).toBeUndefined()
  })
})

describe('symbolCounts', () => {
  const counts = [
    { group: 'a', count: 3 },
    { group: 'b', count: 1 },
    { group: '2', count: 4 },
    { group: 'か', count: 2 },
    { group: 'カ', count: 5 },
    { group: '', count: 1 },
  ]

  test('is unknown until the server has answered', () => {
    expect(symbolCounts(undefined, SERIES_GROUPS_ALPHA)).toBeUndefined()
  })

  test('counts each letter, and puts what is no letter under the rest', () => {
    const result = symbolCounts(counts, SERIES_GROUPS_ALPHA)!
    expect(result['A']).toBe(3)
    expect(result['B']).toBe(1)
    expect(result['C']).toBe(0)
    expect(result['ALL']).toBe(16)
    // The digits, the kana and the empty title.
    expect(result['#']).toBe(12)
  })

  test('counts by the grouping in use', () => {
    const result = symbolCounts(counts, SERIES_GROUPS_JAPANESE)!
    expect(result['か']).toBe(7)
    expect(result['あ']).toBe(0)
    expect(result['ALL']).toBe(16)
    // Now it is the Latin letters that are the rest.
    expect(result['#']).toBe(9)
  })

  test('counts a group the server spelled in capitals or with an accent', () => {
    const result = symbolCounts(
      [
        { group: 'A', count: 1 },
        { group: 'á', count: 2 },
      ],
      SERIES_GROUPS_ALPHA,
    )!
    expect(result['A']).toBe(3)
    expect(result['#']).toBe(0)
  })

  test('is all zeroes for an empty library', () => {
    const result = symbolCounts([], SERIES_GROUPS_ALPHA)!
    expect(result['ALL']).toBe(0)
    expect(result['#']).toBe(0)
    expect(result['A']).toBe(0)
  })
})
