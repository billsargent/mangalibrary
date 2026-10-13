import { describe, expect, test } from 'vitest'
import { bookTitleCompact, clampPage, cycle, readingDirectionFor, toReaderPages } from './reader'
import type { PageDto } from '@/generated/openapi'

const page = (number: number, mediaType: string): PageDto => ({
  number,
  mediaType,
  fileName: `${number}.img`,
  size: '1 KB',
  width: 800,
  height: 1200,
})

describe('toReaderPages', () => {
  test('addresses a page a browser can show as it is', () => {
    const [first] = toReaderPages('B1', [page(1, 'image/jpeg')])
    expect(first).toMatchObject({ number: 1, width: 800, height: 1200 })
    expect(first?.url).toMatch(/\/api\/v1\/books\/B1\/pages\/1$/)
  })

  test('asks for a page a browser cannot show as a JPEG', () => {
    const pages = toReaderPages('B1', [
      page(1, 'image/jxl'),
      page(2, 'IMAGE/WEBP'),
      page(3, 'image/tiff'),
    ])
    expect(pages[0]?.url).toMatch(/\/pages\/1\?convert=jpeg$/)
    expect(pages[1]?.url).toMatch(/\/pages\/2$/)
    expect(pages[2]?.url).toMatch(/\/pages\/3\?convert=jpeg$/)
  })
})

describe('bookTitleCompact', () => {
  test('leaves alone a title that already names its series', () => {
    expect(bookTitleCompact('Akira Volume 3', 'akira', '3')).toBe('Akira Volume 3')
  })

  test('puts the series and the number before a title that does not', () => {
    expect(bookTitleCompact('Volume 3', 'Akira', '3')).toBe('Akira - 3 - Volume 3')
  })

  test('leaves the number out for a book that has none to show', () => {
    expect(bookTitleCompact('The Art Book', 'Akira')).toBe('Akira - The Art Book')
  })
})

describe('clampPage', () => {
  test('accepts a page of the book, given as a number or as text', () => {
    expect(clampPage(1, 10)).toBe(1)
    expect(clampPage('10', 10)).toBe(10)
  })

  test('refuses anything that is not a page of the book', () => {
    expect(clampPage(0, 10)).toBeUndefined()
    expect(clampPage(11, 10)).toBeUndefined()
    expect(clampPage('2.5', 10)).toBeUndefined()
    expect(clampPage(undefined, 10)).toBeUndefined()
    expect(clampPage('abc', 10)).toBeUndefined()
  })
})

describe('cycle', () => {
  test('goes to the next value, and round to the first', () => {
    expect(cycle(['a', 'b', 'c'], 'a')).toBe('b')
    expect(cycle(['a', 'b', 'c'], 'c')).toBe('a')
  })

  test('starts from the first for a value that is not in the list', () => {
    expect(cycle([0, 5, 10], 7)).toBe(0)
  })
})

describe('readingDirectionFor', () => {
  test('is the preference when the series names no direction', () => {
    expect(readingDirectionFor({ preference: 'WEBTOON' })).toEqual({
      direction: 'WEBTOON',
      decidedBySeries: false,
    })
    expect(readingDirectionFor({ fromSeries: null, preference: 'VERTICAL' }).direction).toBe(
      'VERTICAL',
    )
    expect(readingDirectionFor({ fromSeries: '', preference: 'VERTICAL' }).direction).toBe(
      'VERTICAL',
    )
  })

  test('is what the series names, and says so when that is not the preference', () => {
    expect(readingDirectionFor({ fromSeries: 'RIGHT_TO_LEFT', preference: 'WEBTOON' })).toEqual({
      direction: 'RIGHT_TO_LEFT',
      decidedBySeries: true,
    })
    expect(
      readingDirectionFor({ fromSeries: 'RIGHT_TO_LEFT', preference: 'RIGHT_TO_LEFT' }),
    ).toEqual({ direction: 'RIGHT_TO_LEFT', decidedBySeries: false })
  })

  test('is what the reader picked for the series, over what the series names', () => {
    expect(
      readingDirectionFor({
        chosenForSeries: 'WEBTOON',
        fromSeries: 'LEFT_TO_RIGHT',
        preference: 'RIGHT_TO_LEFT',
      }),
    ).toEqual({ direction: 'WEBTOON', decidedBySeries: false })
  })

  test('is the preference whatever the series says, when series are not followed', () => {
    expect(
      readingDirectionFor({
        chosenForSeries: 'VERTICAL',
        fromSeries: 'LEFT_TO_RIGHT',
        preference: 'WEBTOON',
        followSeries: false,
      }),
    ).toEqual({ direction: 'WEBTOON', decidedBySeries: false })
  })

  test('ignores a direction this reader does not know', () => {
    expect(readingDirectionFor({ fromSeries: 'DIAGONAL', preference: 'LEFT_TO_RIGHT' })).toEqual({
      direction: 'LEFT_TO_RIGHT',
      decidedBySeries: false,
    })
  })
})
