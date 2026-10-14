/**
 * Full-text search on the FTS5 indexes.
 *
 * The reference searches a Lucene index, which holds a document per book, series,
 * collection and read list; here the same thing is a `MATCH` against the FTS5 tables
 * migration 0009 built. What is searchable is what those tables hold, and that is the
 * reference's own choice of fields: a book's title and ISBN, a series' title and title
 * sort, a collection's and a read list's name.
 *
 * Two things a caller's term can do are handled here rather than being passed on:
 *
 * - A term is broken into words and each word is quoted, so the FTS5 query language
 *   cannot be reached from a search box. `"` in a term, `*`, `-`, `NEAR` or `:` are
 *   all just characters somebody typed, and a term that is only punctuation matches
 *   nothing instead of failing the query.
 * - The words are joined with `AND`, which is the default operator the reference's
 *   query parser is given.
 *
 * Relevance is `bm25`, which is not Lucene's model: both put a document with the term
 * in its title above one with it in its publisher, but the numbers they rank by are
 * their own. See `docs/COMPATIBILITY.md`.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely'

import type { DB } from '../db/schema.js'

/** The most ids a search returns, as the reference caps its own at 1000. */
export const FULL_TEXT_LIMIT = 1000

/** Which of the indexed columns a search looks at, per entity. */
const COLUMNS: Record<string, readonly string[]> = {
  fts_books: ['title', 'isbn'],
  fts_series: ['title', 'title_sort'],
  fts_collections: ['name'],
  fts_readlists: ['name'],
}

/**
 * A search term as an FTS5 query, or null when it cannot match anything.
 *
 * A term is broken into words, each is quoted, and a word that ends with `*` becomes a
 * prefix query - which is the one piece of the search syntax the reference's parser
 * gives a client, and the one a search box relies on while somebody is still typing.
 * Every other character that would mean something to FTS5 is just punctuation.
 *
 * A term with no words at all is not an error and not a match: the reference's parser
 * throws on one and its caller answers with nothing, which is the same outcome.
 */
export function matchExpression(table: string, term: string): string | null {
  const words = term.split(/[^\p{L}\p{N}*]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word))
  if (words.length === 0) return null

  const columns = COLUMNS[table]
  if (columns === undefined) throw new Error(`${table} is not a full-text index this server knows`)

  const searched = words
    .map((word) => {
      const core = word.replace(/\*/g, '')
      return word.endsWith('*') ? `"${core}"*` : `"${core}"`
    })
    .join(' AND ')

  return `{${columns.join(' ')}} : (${searched})`
}

/** An index, the column in it that names the entity, and where that entity is a table. */
interface Index {
  table: string
  /** The unindexed column holding the entity id. */
  id: string
  /** The entity table, which a caller's query selects from. */
  entity: string
}

const BOOKS: Index = { table: 'fts_books', id: 'book_id', entity: 'books' }
const SERIES: Index = { table: 'fts_series', id: 'series_id', entity: 'series' }
const COLLECTIONS: Index = { table: 'fts_collections', id: 'id', entity: 'collections' }
const READ_LISTS: Index = { table: 'fts_readlists', id: 'id', entity: 'readlists' }

/**
 * A filter for a query: the entity is one the index matched.
 *
 * Null means the term cannot match anything, which a caller answers with no rows
 * rather than with an unfiltered list.
 */
export function matchFilter(db: Kysely<DB>, index: Index, term: string): RawBuilder<boolean> | null {
  const expression = matchExpression(index.table, term)
  if (expression === null) return null

  return sql<boolean>`${sql.ref(`${index.entity}.id`)} in (
    select ${sql.id(index.table, index.id)} from ${sql.table(index.table)}
    where ${sql.table(index.table)} match ${expression}
  )`
}

/** What a relevance sort ranks by: the index, and the match it ranks. */
const RANKED = new WeakMap<object, { index: Index; expression: string }>()

/**
 * How well the entity matches, for ordering by relevance - or null when the term
 * cannot match, in which case there is nothing to order by.
 *
 * It is a column of the ranks `withRelevance` joins: every match ranked once, by
 * `bm25`. Asked row by row instead - a subquery per entity - the database ran the
 * whole search again for every match, and a search for a common word on a large
 * library took 22 seconds (#162); ranked once and joined, 9 ms.
 *
 * `bm25` counts down: the best match is the most negative, so this is used in
 * ascending order, which is what the FTS5 documentation recommends. A row the term
 * never matched is already filtered out, so its missing score cannot be seen.
 */
export function relevanceSort(index: Index, term: string): RawBuilder<number> | null {
  const expression = matchExpression(index.table, term)
  if (expression === null) return null

  const column = sql<number>`relevance_rank.score`
  RANKED.set(column, { index, expression })
  return column
}

/**
 * The query with the ranks a relevance sort orders by, when one of `sorts` is one;
 * the query as it was otherwise. Only the entities the search matched have a rank,
 * which the search's own filter has already narrowed the query to.
 */
export function withRelevance<QB>(query: QB, sorts: readonly { column: unknown }[]): QB {
  const ranked = sorts
    .map((sort) => (typeof sort.column === 'object' && sort.column !== null ? RANKED.get(sort.column) : undefined))
    .find((entry) => entry !== undefined)
  if (ranked === undefined) return query

  const { index, expression } = ranked
  const ranks = sql`(
    select ${sql.id(index.table, index.id)} as id, bm25(${sql.table(index.table)}) as score
    from ${sql.table(index.table)}
    where ${sql.table(index.table)} match ${expression}
  )`.as('relevance_rank')
  const joinable = query as unknown as {
    innerJoin(table: unknown, on: (join: { onRef(a: string, op: '=', b: string): unknown }) => unknown): QB
  }
  return joinable.innerJoin(ranks, (join) => join.onRef('relevance_rank.id', '=', `${index.entity}.id`))
}

/** The ids a term matches, best first - for callers that page in memory. */
export async function matchingIds(db: Kysely<DB>, index: Index, term: string): Promise<string[]> {
  const expression = matchExpression(index.table, term)
  if (expression === null) return []

  const rows = await sql<{ id: string }>`
    select ${sql.id(index.table, index.id)} as id from ${sql.table(index.table)}
    where ${sql.table(index.table)} match ${expression}
    order by bm25(${sql.table(index.table)}), ${sql.id(index.table, index.id)}
    limit ${FULL_TEXT_LIMIT}
  `.execute(db)

  return rows.rows.map((row) => row.id)
}

/** The indexes, so a caller does not have to know how they are shaped. */
export const INDEXES = { BOOKS, SERIES, COLLECTIONS, READ_LISTS } as const
