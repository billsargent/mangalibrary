import { describe, expect, test } from 'vitest'
import { searchRoute, searchTerm } from './search'

describe('searchTerm', () => {
  test('is the q parameter, without the spaces around it', () => {
    expect(searchTerm('akira')).toBe('akira')
    expect(searchTerm('  one piece ')).toBe('one piece')
  })

  test('is the first when the parameter is given twice', () => {
    expect(searchTerm(['akira', 'dragon ball'])).toBe('akira')
  })

  test('is empty when there is nothing to search for', () => {
    expect(searchTerm(undefined)).toBe('')
    expect(searchTerm(null)).toBe('')
    expect(searchTerm('   ')).toBe('')
    expect(searchTerm([])).toBe('')
  })
})

describe('searchRoute', () => {
  test('is the search page with the term in its address', () => {
    expect(searchRoute(' akira ')).toEqual({ name: '/search', query: { q: 'akira' } })
  })

  test('is nowhere when there is nothing to search for', () => {
    expect(searchRoute('')).toBeNull()
    expect(searchRoute('   ')).toBeNull()
  })
})
