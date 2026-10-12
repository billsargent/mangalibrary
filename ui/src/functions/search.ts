import type { LocationQueryValue } from 'vue-router'

/**
 * What an address asks to search for, from its `q` parameter.
 *
 * A parameter given twice counts once, and one that is only spaces is no search
 * at all.
 */
export function searchTerm(query: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const value = Array.isArray(query) ? query[0] : query
  return (value ?? '').trim()
}

/** Where a search for `term` lives, or null when there is nothing to search for. */
export function searchRoute(term: string): { name: '/search'; query: { q: string } } | null {
  const trimmed = term.trim()
  return trimmed === '' ? null : { name: '/search', query: { q: trimmed } }
}
