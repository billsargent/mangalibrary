import { describe, expect, test } from 'vitest'
import { buildSpreads, isPageLandscape, pageOfSpread, spreadIndexOf } from './book-spreads'
import type { ReaderPage } from '@/types/reader'

/** Pages numbered from 1; the numbers listed as `landscape` are wider than tall. */
function book(count: number, landscape: number[] = []): ReaderPage[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const wide = landscape.includes(number)
    return {
      number,
      url: `/pages/${number}`,
      mediaType: 'image/jpeg',
      fileName: `${number}.jpg`,
      width: wide ? 2000 : 1000,
      height: 1500,
    }
  })
}

/** Spreads as page numbers, with `0` for a blank half. */
const numbers = (spreads: ReaderPage[][]) =>
  spreads.map((spread) => spread.map((page) => page.number))

describe('isPageLandscape', () => {
  test('a page with no size is not landscape', () => {
    expect(isPageLandscape({})).toBe(false)
    expect(isPageLandscape({ width: 2, height: 1 })).toBe(true)
    expect(isPageLandscape({ width: 1, height: 1 })).toBe(false)
  })
})

describe('buildSpreads', () => {
  test('an empty book has no spreads', () => {
    expect(buildSpreads([], 'DOUBLE_PAGES')).toEqual([])
  })

  test('single page shows one page at a time', () => {
    expect(numbers(buildSpreads(book(3), 'SINGLE_PAGE'))).toEqual([[1], [2], [3]])
  })

  test('double pages keeps the cover and the back cover alone, each on its own side', () => {
    expect(numbers(buildSpreads(book(6), 'DOUBLE_PAGES'))).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 0],
    ])
  })

  test('double pages gives an odd page out a blank partner', () => {
    expect(numbers(buildSpreads(book(5), 'DOUBLE_PAGES'))).toEqual([
      [0, 1],
      [2, 3],
      [4, 0],
      [5, 0],
    ])
  })

  test('double pages of a one-page book is that page', () => {
    expect(numbers(buildSpreads(book(1), 'DOUBLE_PAGES'))).toEqual([[0, 1]])
  })

  test('without a cover, pages pair from the first', () => {
    expect(numbers(buildSpreads(book(5), 'DOUBLE_NO_COVER'))).toEqual([
      [1, 2],
      [3, 4],
      [5, 0],
    ])
  })

  test('a landscape page stands alone, and the page before it does not wait for a partner', () => {
    expect(numbers(buildSpreads(book(7, [4]), 'DOUBLE_PAGES'))).toEqual([
      [0, 1],
      [2, 3],
      [4],
      [5, 6],
      [7, 0],
    ])
    expect(numbers(buildSpreads(book(6, [3]), 'DOUBLE_NO_COVER'))).toEqual([
      [1, 2],
      [3],
      [4, 5],
      [6, 0],
    ])
    expect(numbers(buildSpreads(book(5, [3]), 'DOUBLE_PAGES'))).toEqual([
      [0, 1],
      [2, 0],
      [3],
      [4, 0],
      [5, 0],
    ])
  })

  test('a landscape cover or back cover has no blank beside it', () => {
    expect(numbers(buildSpreads(book(4, [1, 4]), 'DOUBLE_PAGES'))).toEqual([[1], [2, 3], [4]])
  })

  test('a blank half takes the size of the page it stands beside', () => {
    const [cover] = buildSpreads(book(2), 'DOUBLE_PAGES')
    expect(cover?.[0]).toMatchObject({ blank: true, width: 1000, height: 1500, url: '' })
  })

  test('the pages given are not changed', () => {
    const pages = book(4)
    buildSpreads(pages, 'DOUBLE_PAGES')
    expect(pages.map((page) => page.number)).toEqual([1, 2, 3, 4])
  })
})

describe('spreadIndexOf and pageOfSpread', () => {
  const spreads = buildSpreads(book(6), 'DOUBLE_PAGES')

  test('finds the spread a page is in', () => {
    expect(spreadIndexOf(spreads, 1)).toBe(0)
    expect(spreadIndexOf(spreads, 2)).toBe(1)
    expect(spreadIndexOf(spreads, 3)).toBe(1)
    expect(spreadIndexOf(spreads, 6)).toBe(3)
  })

  test('falls back to the first spread for a page the book does not have', () => {
    expect(spreadIndexOf(spreads, 99)).toBe(0)
  })

  test('a spread stands for its last real page, so the last spread is the last page', () => {
    expect(pageOfSpread(spreads[0]!)).toBe(1)
    expect(pageOfSpread(spreads[1]!)).toBe(3)
    expect(pageOfSpread(spreads[3]!)).toBe(6)
  })
})
