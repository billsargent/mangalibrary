import { describe, expect, test } from 'vitest'
import { cloudLetters, TAG_SIZES, tagSize } from './tag-cloud'

describe('tagSize', () => {
  test('the largest tag is the largest size, a tag of one the smallest', () => {
    expect(tagSize(5000, 5000)).toBe(TAG_SIZES.length - 1)
    expect(tagSize(1, 5000)).toBe(0)
  })

  test('grows by orders of magnitude, so one huge tag does not flatten the rest', () => {
    const sizes = [1, 10, 100, 1000, 10000].map((count) => tagSize(count, 10000))
    expect(sizes).toEqual([0, 1, 2, 3, 4])
  })

  test('a scope where no tag has more than one is all one size', () => {
    expect(tagSize(1, 1)).toBe(0)
    expect(tagSize(0, 0)).toBe(0)
  })
})

describe('cloudLetters', () => {
  test('lists the letters there are tags under, # first, and counts the tags', () => {
    const tags = [
      { tag: 'gore', letter: 'g', count: 3 },
      { tag: '9 lives', letter: '#', count: 1 },
      { tag: 'classic', letter: 'c', count: 2 },
      { tag: 'colour', letter: 'c', count: 1 },
    ]
    expect(cloudLetters(tags)).toEqual({ letters: ['#', 'c', 'g'], counts: { '#': 1, c: 2, g: 1 } })
  })
})
