import { sql, type RawBuilder } from 'kysely'

/** A column name, or an expression such as a correlated subquery, to sort by. */
export type SortKey = string | RawBuilder<unknown>

/** One `sort` criterion: `property,asc|desc`. */
export interface SortSpec {
  column: SortKey
  direction: 'asc' | 'desc'
}

export interface Paging {
  page: number
  size: number
}

export const DEFAULT_PAGE_SIZE = 20

/** Coerce a query parameter that may be absent, scalar or repeated into an array. */
export function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry) => String(entry)).filter((entry) => entry !== '')
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function paging(query: unknown): Paging {
  const params = (query ?? {}) as { page?: unknown; size?: unknown }
  return {
    page: Math.max(0, toNumber(params.page, 0)),
    size: Math.max(0, toNumber(params.size, DEFAULT_PAGE_SIZE)),
  }
}

/**
 * Parse an optional boolean query parameter.
 *
 * `null` means "not asked for", which callers treat differently from an explicit
 * false: most list endpoints default to excluding deleted items, but leave other
 * flags unconstrained until a client sets them.
 */
export function booleanParam(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).toLowerCase()
  if (text === 'true') return true
  if (text === 'false') return false
  return null
}

/**
 * Parse Spring-style `sort` parameters.
 *
 * Unknown properties are dropped rather than rejected: a client asking for a
 * property we do not support still gets a stable, documented order, and the
 * fallback guarantees the result is deterministic (which paging requires). A
 * property may name an expression rather than a column, which is what sorting by a
 * count needs.
 */
export function parseSort(raw: unknown, allowed: Record<string, SortKey>, fallback: readonly SortSpec[]): SortSpec[] {
  const specs: SortSpec[] = []
  for (const entry of toArray(raw)) {
    const [rawField, rawDirection] = entry.split(',')
    const column = allowed[rawField?.trim() ?? '']
    if (column === undefined) continue
    const direction = (rawDirection ?? 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc'
    specs.push({ column, direction })
  }
  return specs.length > 0 ? specs : [...fallback]
}

/**
 * The value a search condition requires a field to be, wherever in the condition
 * that is said: `{ field: { operator: 'is', value } }`.
 *
 * Sorting by a position in a collection or a read list needs to know which one,
 * and a client names it in the condition it filters by. The first one found is
 * the one meant; a condition naming two has no single order to give.
 */
export function requiredValue(condition: unknown, field: string): string | undefined {
  if (Array.isArray(condition)) {
    for (const entry of condition) {
      const found = requiredValue(entry, field)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (condition === null || typeof condition !== 'object') return undefined

  const node = condition as Record<string, unknown>
  const own = node[field]
  if (own !== null && typeof own === 'object') {
    const { operator, value } = own as Record<string, unknown>
    if (operator === 'is' && typeof value === 'string') return value
  }
  return requiredValue(node.allOf, field) ?? requiredValue(node.anyOf, field)
}

/**
 * Apply sort criteria to a query builder.
 *
 * The cast is deliberate: `column` has already been resolved through an
 * allow-list in `parseSort`, so it is always a real column name, but a plain
 * string cannot satisfy Kysely's literal key union.
 */
export function applySort<QB>(query: QB, sorts: readonly SortSpec[]): QB {
  let builder = query as {
    orderBy(column: never, direction: 'asc' | 'desc'): unknown
  }
  for (const spec of sorts) {
    builder = builder.orderBy(spec.column as never, spec.direction) as typeof builder
  }
  return builder as unknown as QB
}

/** `column LIKE %value%`, case-insensitively, with the wildcards escaped. */
export function likeAny(column: string, value: string): RawBuilder<boolean> {
  const pattern = `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
  return sql<boolean>`lower(${sql.ref(column)}) like ${pattern.toLowerCase()} escape '\\'`
}

/** Whether `value` is a regular expression SQLite's REGEXP implementation accepts. */
export function isRegex(value: string): boolean {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}

export interface JsonSearch<T> {
  condition?: T
  fullTextSearch?: string
}

/**
 * The body of `POST .../list`. Only `fullTextSearch` is honoured for now;
 * `condition` is the structured search language and lands with the search work.
 */
export function readSearchBody<T>(body: unknown): JsonSearch<T> {
  const parsed = (body ?? {}) as JsonSearch<T>
  return {
    condition: parsed.condition,
    fullTextSearch: typeof parsed.fullTextSearch === 'string' ? parsed.fullTextSearch : undefined,
  }
}
