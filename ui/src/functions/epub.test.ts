import { describe, expect, test } from 'vitest'
import {
  chapterIndexOf,
  fragmentOf,
  pageAt,
  pageCount,
  percent,
  positionAt,
  progressionOf,
  resourcePath,
  type EpubPosition,
} from './epub'

const base = 'http://localhost:25600/api/v1/books/B1/resource/'

describe('resourcePath', () => {
  test('is what follows resource/, decoded and without its fragment', () => {
    expect(resourcePath(`${base}OEBPS/chapter1.xhtml`)).toBe('OEBPS/chapter1.xhtml')
    expect(resourcePath(`${base}OEBPS/chapter%201.xhtml#top`)).toBe('OEBPS/chapter 1.xhtml')
  })

  test('is the address itself when it is already a path', () => {
    expect(resourcePath('OEBPS/chapter1.xhtml#note')).toBe('OEBPS/chapter1.xhtml')
  })
})

describe('fragmentOf', () => {
  test('is the part after the hash, decoded', () => {
    expect(fragmentOf(`${base}ch1.xhtml#note-3`)).toBe('note-3')
    expect(fragmentOf(`${base}ch1.xhtml#caf%C3%A9`)).toBe('café')
  })

  test('is nothing when there is no fragment', () => {
    expect(fragmentOf(`${base}ch1.xhtml`)).toBeUndefined()
    expect(fragmentOf(`${base}ch1.xhtml#`)).toBeUndefined()
  })
})

describe('chapterIndexOf', () => {
  const readingOrder = [{ href: `${base}ch1.xhtml` }, { href: `${base}ch2.xhtml` }, {}]

  test('finds the chapter an address belongs to, whatever its fragment', () => {
    expect(chapterIndexOf(readingOrder, `${base}ch2.xhtml#middle`)).toBe(1)
    expect(chapterIndexOf(readingOrder, 'ch1.xhtml')).toBe(0)
  })

  test('is -1 for an address outside the reading order', () => {
    expect(chapterIndexOf(readingOrder, `${base}style.css`)).toBe(-1)
    expect(chapterIndexOf(readingOrder, 'https://example.org/')).toBe(-1)
  })
})

describe('positionAt', () => {
  const positions: EpubPosition[] = [
    { href: 'ch1.xhtml', locations: { progression: 0, position: 1, totalProgression: 0.25 } },
    { href: 'ch1.xhtml', locations: { progression: 0.5, position: 2, totalProgression: 0.5 } },
    { href: 'ch2.xhtml', locations: { progression: 0, position: 3, totalProgression: 0.75 } },
    { href: 'ch2.xhtml', locations: { progression: 0.5, position: 4, totalProgression: 1 } },
  ]

  test('is the last position of the resource that starts at or before the place', () => {
    expect(positionAt(positions, { path: 'ch1.xhtml', progression: 0 })?.position).toBe(1)
    expect(positionAt(positions, { path: 'ch1.xhtml', progression: 0.49 })?.position).toBe(1)
    expect(positionAt(positions, { path: 'ch1.xhtml', progression: 0.5 })?.position).toBe(2)
    expect(positionAt(positions, { path: 'ch2.xhtml', progression: 0.99 })).toEqual({
      position: 4,
      totalProgression: 1,
    })
  })

  test('is nothing for a resource the book has no position in', () => {
    expect(positionAt(positions, { path: 'nav.xhtml', progression: 0 })).toBeUndefined()
  })
})

describe('pages', () => {
  test('a chapter is as many pages as its width holds', () => {
    expect(pageCount(3000, 1000)).toBe(3)
    expect(pageCount(3000.4, 1000)).toBe(3)
    expect(pageCount(3200, 1000)).toBe(4)
    expect(pageCount(0, 1000)).toBe(1)
    expect(pageCount(500, 0)).toBe(1)
  })

  test('a progression falls on a page, and a page starts at a progression', () => {
    expect(pageAt(0, 4)).toBe(0)
    expect(pageAt(0.5, 4)).toBe(2)
    expect(pageAt(1, 4)).toBe(3)
    expect(progressionOf(2, 4)).toBe(0.5)
    // Going there and back lands on the same page.
    for (let page = 0; page < 7; page += 1) expect(pageAt(progressionOf(page, 7), 7)).toBe(page)
  })

  test('a percentage is whole and stays between 0 and 100', () => {
    expect(percent(0.256)).toBe(26)
    expect(percent(1.2)).toBe(100)
    expect(percent(-1)).toBe(0)
  })
})
