import { describe, expect, it } from 'vitest'

import { ProgressionError, epubProgress, pagedProgress, type StoredPosition } from './progression.js'

/** Two chapters: the first with three positions, the second with one. */
const positions: StoredPosition[] = [
  {
    href: 'ch1.xhtml',
    type: 'application/xhtml+xml',
    koboSpan: 'kobo.1.1',
    locations: { progression: 0, position: 1, totalProgression: 0.25 },
  },
  {
    href: 'ch1.xhtml',
    type: 'application/xhtml+xml',
    locations: { progression: 1 / 3, position: 2, totalProgression: 0.5 },
  },
  {
    href: 'ch1.xhtml',
    type: 'application/xhtml+xml',
    locations: { progression: 2 / 3, position: 3, totalProgression: 0.75 },
  },
  {
    href: 'ch 2.xhtml',
    type: 'application/xhtml+xml',
    koboSpan: 'kobo.1.1',
    locations: { progression: 0, position: 4, totalProgression: 1 },
  },
]

describe('pagedProgress', () => {
  it('takes the position as the page, and the last page as the end', () => {
    expect(pagedProgress({ locations: { position: 3 } }, 10)).toMatchObject({ page: 3, completed: false })
    expect(pagedProgress({ locations: { position: 10 } }, 10)).toMatchObject({ page: 10, completed: true })
  })

  it('refuses a position the book does not have', () => {
    for (const position of [0, 11, 2.5, '3', undefined]) {
      expect(() => pagedProgress({ locations: { position } }, 10)).toThrow(ProgressionError)
    }
  })
})

describe('epubProgress', () => {
  it('matches a locator that sits exactly on a position', () => {
    const progress = epubProgress({ href: 'ch1.xhtml', locations: { progression: 1 / 3 } }, positions, 4)
    expect(progress).toMatchObject({ page: 2, completed: false })
    expect(progress.locator).toMatchObject({
      href: 'ch1.xhtml',
      type: 'application/xhtml+xml',
      locations: { progression: 1 / 3, totalProgression: 0.5 },
    })
  })

  it('takes the position before a locator that sits between two', () => {
    expect(epubProgress({ href: 'ch1.xhtml', locations: { progression: 0.5 } }, positions, 4)).toMatchObject({
      page: 2,
      completed: false,
    })
  })

  it('takes the last position of a resource for a locator past it', () => {
    expect(epubProgress({ href: 'ch1.xhtml', locations: { progression: 0.9 } }, positions, 4)).toMatchObject({
      page: 3,
      completed: false,
    })
  })

  it('marks the book read at its last position', () => {
    // A resource with one position matches it wherever the reader is in it.
    expect(epubProgress({ href: 'ch%202.xhtml#end', locations: { progression: 0.6 } }, positions, 4)).toMatchObject({
      page: 4,
      completed: true,
    })
  })

  it('keeps what the reader sent, corrects the total, and fills in what is missing', () => {
    const { locator } = epubProgress(
      { href: 'ch1.xhtml', type: 'text/html', title: 'One', locations: { progression: 0, totalProgression: 0.9 } },
      positions,
      4,
    )
    expect(locator).toEqual({
      href: 'ch1.xhtml',
      type: 'application/xhtml+xml',
      title: 'One',
      koboSpan: 'kobo.1.1',
      locations: { progression: 0, totalProgression: 0.25 },
    })
  })

  it('refuses a resource the book does not have, and a locator with no progression', () => {
    expect(() => epubProgress({ href: 'missing.xhtml', locations: { progression: 0 } }, positions, 4)).toThrow(
      /Resource does not exist/,
    )
    expect(() => epubProgress({ href: 'ch1.xhtml', locations: {} }, positions, 4)).toThrow(/progression is required/)
    expect(() => epubProgress({ href: 'ch1.xhtml', locations: { progression: 1.5 } }, positions, 4)).toThrow(
      /Invalid progression/,
    )
  })
})
