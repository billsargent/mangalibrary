import { describe, expect, test } from 'vitest'
import { analysisSearch, missingPostersSearch } from './media-pages'

describe('analysisSearch', () => {
  test('is no search when no status is chosen', () => {
    expect(analysisSearch([], [])).toBeNull()
    expect(analysisSearch([], ['L1'])).toBeNull()
  })

  test('looks for any of the chosen statuses, in every library', () => {
    expect(analysisSearch(['ERROR', 'UNSUPPORTED'], [])).toEqual({
      condition: {
        allOf: [
          {
            anyOf: [
              { mediaStatus: { operator: 'is', value: 'ERROR' } },
              { mediaStatus: { operator: 'is', value: 'UNSUPPORTED' } },
            ],
          },
        ],
      },
    })
  })

  test('narrows to the chosen libraries', () => {
    expect(analysisSearch(['ERROR'], ['L1', 'L2'])).toEqual({
      condition: {
        allOf: [
          { anyOf: [{ mediaStatus: { operator: 'is', value: 'ERROR' } }] },
          {
            anyOf: [
              { libraryId: { operator: 'is', value: 'L1' } },
              { libraryId: { operator: 'is', value: 'L2' } },
            ],
          },
        ],
      },
    })
  })
})

describe('missingPostersSearch', () => {
  test('looks for analysed books with no poster selected', () => {
    expect(missingPostersSearch()).toEqual({
      condition: {
        allOf: [
          { mediaStatus: { operator: 'is', value: 'READY' } },
          { poster: { operator: 'isNot', value: { selected: true } } },
        ],
      },
    })
  })
})
