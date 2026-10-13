import { describe, expect, test } from 'vitest'
import { contentsRows, withAdded, withRemoved } from './contents'

describe('contentsRows', () => {
  const known = new Map([
    ['S1', { title: 'Akira' }],
    ['S2', { title: 'Berserk', subtitle: 'Manga' }],
  ])

  test('follows the order of the ids, not of what is known', () => {
    expect(contentsRows(['S2', 'S1'], known)).toEqual([
      { id: 'S2', title: 'Berserk', subtitle: 'Manga' },
      { id: 'S1', title: 'Akira' },
    ])
  })

  test('keeps a row for an id nothing is known about', () => {
    expect(contentsRows(['S9'], known)).toEqual([{ id: 'S9', title: 'S9' }])
    expect(contentsRows([], known)).toEqual([])
  })
})

describe('adding and removing', () => {
  test('adds at the end, once', () => {
    expect(withAdded(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(withAdded(['a', 'b'], 'a')).toEqual(['a', 'b'])
  })

  test('removes one and leaves the order of the rest', () => {
    expect(withRemoved(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(withRemoved(['a'], 'z')).toEqual(['a'])
  })

  test('does not change the list it was given', () => {
    const ids = ['a', 'b']
    withAdded(ids, 'c')
    withRemoved(ids, 'a')
    expect(ids).toEqual(['a', 'b'])
  })
})
