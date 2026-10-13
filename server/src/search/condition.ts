/**
 * The search condition, as SQL.
 *
 * `POST /api/v1/books/list` and `POST /api/v1/series/list` take a typed tree - the
 * same one the reference builds a jOOQ condition from - and this translates it. The
 * rules are the reference's, down to the odd ones: a substring comparison ignores
 * case *and* accents, `greaterThan` and `lessThan` are inclusive, `isNot` on a
 * nullable number also matches a row with no value, and "has no tag" means the book
 * or series has no tag at all rather than a tag that is empty.
 *
 * A condition that names a field this server does not know, or an operator that does
 * not belong with it, is refused rather than ignored: a filter that silently does
 * nothing shows somebody the whole library when they asked for part of it.
 *
 * The fragments are correlated to the query they are added to - `books.id`,
 * `series.id` - so a caller adds them to a query that has the entity table joined,
 * which is what both list endpoints do.
 */

import { sql, type RawBuilder } from 'kysely'

/** A filter, ready to be a `where` clause of the query it belongs to. */
export type ConditionFilter = RawBuilder<boolean>

export type ConditionResult = { filter: ConditionFilter } | { error: string }

export interface ConditionContext {
  /** Whose read progress a read-status filter is about; with none, it matches nothing. */
  userId: string | null
}

/**
 * The media types each profile covers.
 *
 * A database this server scanned holds the short type and one carried over from
 * Komga holds the same short type, but a client of the reference may have stored the
 * comic-book spelling, so both are listed - as they are in `content-dto.ts`.
 */
const MEDIA_PROFILES: Record<string, readonly string[]> = {
  DIVINA: [
    'application/zip',
    'application/x-rar-compressed',
    'application/x-rar-compressed; version=4',
    'application/x-rar-compressed; version=5',
    'application/vnd.comicbook+zip',
    'application/vnd.comicbook-rar',
  ],
  EPUB: ['application/epub+zip', 'application/kepub+zip'],
  PDF: ['application/pdf'],
}

const READ_STATUSES = ['UNREAD', 'READ', 'IN_PROGRESS'] as const

const EQUALITY = ['is', 'isNot'] as const
const NULLABLE = ['is', 'isNot', 'isNull', 'isNotNull'] as const
const STRING_OP = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'beginsWith',
  'doesNotBeginWith',
  'endsWith',
  'doesNotEndWith',
] as const
const NUMBER_OP = ['is', 'isNot', 'greaterThan', 'lessThan'] as const
const NULLABLE_NUMBER_OP = [...NUMBER_OP, 'isNull', 'isNotNull'] as const
const BOOLEAN_OP = ['isTrue', 'isFalse'] as const
const DATE_OP = ['after', 'before', 'isInTheLast', 'isNotInTheLast', 'isNull', 'isNotNull'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An operator object: `{ operator, value }`, `{ operator, dateTime }` and so on. */
function readOperator(
  field: string,
  node: unknown,
  allowed: readonly string[],
): { operator: string; argument: Record<string, unknown> } | { error: string } {
  if (!isRecord(node)) return { error: `${field} must be an object with an operator` }

  const operator = node.operator
  if (typeof operator !== 'string') return { error: `${field} needs an operator` }
  if (!allowed.includes(operator)) {
    return { error: `${field} does not take the operator ${operator}; it takes ${allowed.join(', ')}` }
  }

  return { operator, argument: node }
}

function textArgument(
  field: string,
  operator: string,
  argument: Record<string, unknown>,
): { value: string } | { error: string } {
  const value = argument.value
  if (typeof value !== 'string') return { error: `${field} ${operator} needs a value that is a string` }
  return { value }
}

function numberArgument(
  field: string,
  operator: string,
  argument: Record<string, unknown>,
): { value: number } | { error: string } {
  const value = argument.value
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${field} ${operator} needs a value that is a number` }
  }
  return { value }
}

/** The date part of an instant, in UTC, as the reference compares it. */
function utcDate(value: string): string | null {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function dateArgument(
  field: string,
  operator: string,
  argument: Record<string, unknown>,
): { date: string } | { error: string } {
  const value = argument.dateTime
  if (typeof value !== 'string') return { error: `${field} ${operator} needs a dateTime` }
  const date = utcDate(value)
  if (date === null) return { error: `${field} ${operator} needs a dateTime this server can read` }
  return { date }
}

/**
 * How many days an ISO-8601 duration is.
 *
 * Only the parts a duration has - days, hours, minutes and seconds - as the
 * reference parses it, so `P1M` is refused there and here: a month is not a length
 * of time until you say which month.
 */
function durationDays(value: string): number | null {
  const match =
    /^([+-])?P(?:([+-]?\d+(?:\.\d+)?)D)?(?:T(?:([+-]?\d+(?:\.\d+)?)H)?(?:([+-]?\d+(?:\.\d+)?)M)?(?:([+-]?\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    )
  if (match === null) return null

  const sign = match[1] === '-' ? -1 : 1
  const days = Number(match[2] ?? 0)
  const hours = Number(match[3] ?? 0)
  const minutes = Number(match[4] ?? 0)
  const seconds = Number(match[5] ?? 0)
  const total = days + hours / 24 + minutes / 1440 + seconds / 86400
  if (!Number.isFinite(total)) return null

  return sign * total
}

function durationArgument(
  field: string,
  operator: string,
  argument: Record<string, unknown>,
): { days: number } | { error: string } {
  const value = argument.duration
  if (typeof value !== 'string') return { error: `${field} ${operator} needs a duration` }
  const days = durationDays(value)
  if (days === null) return { error: `${field} ${operator} needs a duration such as P7D, not ${value}` }
  return { days }
}

/** `%` and `_` are wildcards in a LIKE, so a value that has one is escaped. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/**
 * Compare a column as text, ignoring case and accents, the way a person searching
 * for something expects. `fold` is registered on the connection and is applied to
 * both sides, so the value a caller sent is folded the same way the column is.
 */
function likeText(column: string, operator: string, value: string): ConditionFilter {
  const escaped = escapeLike(value)
  const column_ = sql.ref(column)

  if (operator === 'contains' || operator === 'doesNotContain') {
    const match = sql<boolean>`fold(${column_}) like fold(${'%' + escaped + '%'}) escape '\\'`
    return operator === 'contains' ? match : sql<boolean>`not (${match})`
  }

  if (operator === 'beginsWith' || operator === 'doesNotBeginWith') {
    const match = sql<boolean>`fold(${column_}) like fold(${escaped + '%'}) escape '\\'`
    return operator === 'beginsWith' ? match : sql<boolean>`not (${match})`
  }

  const match = sql<boolean>`fold(${column_}) like fold(${'%' + escaped}) escape '\\'`
  return operator === 'endsWith' ? match : sql<boolean>`not (${match})`
}

/**
 * Equality as text, ignoring case.
 *
 * Not accents: the reference compares `is` and `isNot` with a case-insensitive
 * comparison of the values themselves, and only the substring comparisons look past
 * accents. Matching that is what keeps a filter somebody wrote for Komga meaning the
 * same thing here.
 */
function equalText(column: string, operator: string, value: string): ConditionFilter {
  const comparison = sql<boolean>`lower(${sql.ref(column)}) = lower(${value})`
  return operator === 'is' ? comparison : sql<boolean>`not (${comparison})`
}

/** The operators a free-text field takes, which are the comparison ones. */
function stringOperator(field: string, column: string, node: unknown): ConditionResult {
  const read = readOperator(field, node, STRING_OP)
  if ('error' in read) return read

  const argument = textArgument(field, read.operator, read.argument)
  if ('error' in argument) return argument

  const { operator } = read
  if (operator === 'is' || operator === 'isNot') return { filter: equalText(column, operator, argument.value) }
  return { filter: likeText(column, operator, argument.value) }
}

/** `is`/`isNot` on a column, case-insensitively or not. */
function equalityOperator(field: string, column: string, node: unknown, ignoringCase: boolean): ConditionResult {
  const read = readOperator(field, node, EQUALITY)
  if ('error' in read) return read

  const argument = textArgument(field, read.operator, read.argument)
  if ('error' in argument) return argument

  if (ignoringCase) return { filter: equalText(column, read.operator, argument.value) }

  const comparison = sql<boolean>`${sql.ref(column)} = ${argument.value}`
  return { filter: read.operator === 'is' ? comparison : sql<boolean>`not (${comparison})` }
}

/** `is`/`isNot`/`isNull`/`isNotNull` on a numeric column that can be empty. */
function numberOperator(field: string, column: string, node: unknown): ConditionResult {
  const read = readOperator(field, node, NULLABLE_NUMBER_OP)
  if ('error' in read) return read

  const reference = sql.ref(column)
  switch (read.operator) {
    case 'isNull':
      return { filter: sql<boolean>`${reference} is null` }
    case 'isNotNull':
      return { filter: sql<boolean>`${reference} is not null` }
    default:
      break
  }

  const argument = numberArgument(field, read.operator, read.argument)
  if ('error' in argument) return argument

  return { filter: numericComparison(column, read.operator, argument.value, true) }
}

/** `is`/`isNot`/`greaterThan`/`lessThan` on a numeric column that always has a value. */
function floatOperator(field: string, column: string, node: unknown): ConditionResult {
  const read = readOperator(field, node, NUMBER_OP)
  if ('error' in read) return read

  const argument = numberArgument(field, read.operator, read.argument)
  if ('error' in argument) return argument

  return { filter: numericComparison(column, read.operator, argument.value, false) }
}

/**
 * A numeric comparison, with the reference's two oddities: the two range operators
 * are inclusive, and `isNot` on a nullable column is also true of a row with no
 * value.
 */
function numericComparison(column: string, operator: string, value: number, nullable: boolean): ConditionFilter {
  const reference = sql.ref(column)
  switch (operator) {
    case 'greaterThan':
      return sql<boolean>`${reference} >= ${value}`
    case 'lessThan':
      return sql<boolean>`${reference} <= ${value}`
    case 'is':
      return sql<boolean>`${reference} = ${value}`
    default: {
      const different = sql<boolean>`${reference} <> ${value}`
      return nullable ? sql<boolean>`(${different} or ${reference} is null)` : different
    }
  }
}

/** `isTrue`/`isFalse` on something stored as a boolean. */
function booleanOperator(
  field: string,
  expression: (value: boolean) => ConditionFilter,
  node: unknown,
): ConditionResult {
  const read = readOperator(field, node, BOOLEAN_OP)
  if ('error' in read) return read
  return { filter: expression(read.operator === 'isTrue') }
}

/** A date field, compared by its date part in UTC. */
function dateOperator(field: string, column: string, node: unknown): ConditionResult {
  const read = readOperator(field, node, DATE_OP)
  if ('error' in read) return read

  const reference = sql.ref(column)
  switch (read.operator) {
    case 'isNull':
      return { filter: sql<boolean>`${reference} is null` }
    case 'isNotNull':
      return { filter: sql<boolean>`${reference} is not null` }
    case 'after': {
      const argument = dateArgument(field, read.operator, read.argument)
      return 'error' in argument ? argument : { filter: sql<boolean>`${reference} > ${argument.date}` }
    }
    case 'before': {
      const argument = dateArgument(field, read.operator, read.argument)
      return 'error' in argument ? argument : { filter: sql<boolean>`${reference} < ${argument.date}` }
    }
    default: {
      const argument = durationArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument
      const since = sql<number>`date('now', ${`-${argument.days} days`})`
      return {
        filter:
          read.operator === 'isInTheLast'
            ? sql<boolean>`${reference} > ${since}`
            : sql<boolean>`${reference} < ${since}`,
      }
    }
  }
}

/** A field stored as a list of values in another table. */
interface ListField {
  field: string
  /** The table holding the rows, and the column that points at the entity. */
  table: string
  owner: string
  value: string
  /** A second table whose values count as this entity's own, as a series' books' tags do. */
  also?: { table: string; owner: string; value: string }
}

function listOperator(spec: ListField, entity: string, node: unknown): ConditionResult {
  const read = readOperator(spec.field, node, NULLABLE)
  if ('error' in read) return read

  /** A row of one of the tables that hold this field, pointing at the entity. */
  const row = (table: string, owner: string, value: string, match: string | null): RawBuilder<unknown> => {
    const conditions: RawBuilder<boolean>[] = [
      sql<boolean>`${sql.ref(`${table}.${owner}`)} = ${sql.ref(`${entity}.id`)}`,
    ]
    if (match !== null) conditions.push(sql<boolean>`lower(${sql.ref(`${table}.${value}`)}) = lower(${match})`)

    return sql<unknown>`select 1 from ${sql.ref(table)} where ${sql.join(conditions, sql` and `)}`
  }

  const inner = (value: string): RawBuilder<boolean> => {
    const parts = [row(spec.table, spec.owner, spec.value, value)]
    if (spec.also !== undefined) parts.push(row(spec.also.table, spec.also.owner, spec.also.value, value))
    return sql<boolean>`exists (${sql.join(parts, sql` union all `)})`
  }

  const innerAny = (): RawBuilder<boolean> => {
    const parts = [row(spec.table, spec.owner, spec.value, null)]
    if (spec.also !== undefined) parts.push(row(spec.also.table, spec.also.owner, spec.also.value, null))
    return sql<boolean>`exists (${sql.join(parts, sql` union all `)})`
  }

  switch (read.operator) {
    case 'isNull':
      return { filter: sql<boolean>`not (${innerAny()})` }
    case 'isNotNull':
      return { filter: innerAny() }
    default:
      break
  }

  const argument = textArgument(spec.field, read.operator, read.argument)
  if ('error' in argument) return argument

  const match = inner(argument.value)
  return { filter: read.operator === 'is' ? match : sql<boolean>`not (${match})` }
}

/** Read status of a book: no row is unread, and a row that is not completed is in progress. */
function bookReadStatus(node: unknown, context: ConditionContext): ConditionResult {
  const read = readOperator('readStatus', node, EQUALITY)
  if ('error' in read) return read

  const value = read.argument.value
  if (typeof value !== 'string' || !READ_STATUSES.includes(value as (typeof READ_STATUSES)[number])) {
    return { error: `readStatus takes one of ${READ_STATUSES.join(', ')}` }
  }

  if (context.userId === null) {
    // Without a caller there is no read progress to filter by, which is what the
    // reference answers too - nothing matches rather than everything.
    return { filter: sql<boolean>`false` }
  }

  const completed = value === 'READ' ? 1 : 0
  // Lists of ids rather than a question asked of each book: the database can then
  // start from the reader's progress, which is a handful of rows, where "exists"
  // made it look at every book in the library to find the five being read.
  const exists = sql<boolean>`books.id in (select book_id from read_progress where user_id = ${context.userId} and completed = ${completed})`
  const anyRow = sql<boolean>`books.id in (select book_id from read_progress where user_id = ${context.userId})`

  if (read.operator === 'is') {
    if (value === 'UNREAD') return { filter: sql<boolean>`not (${anyRow})` }
    return { filter: exists }
  }

  if (value === 'UNREAD') return { filter: anyRow }
  return { filter: sql<boolean>`not (${exists})` }
}

/** Read status of a series: how many of its books have been read. */
function seriesReadStatus(node: unknown, context: ConditionContext): ConditionResult {
  const read = readOperator('readStatus', node, EQUALITY)
  if ('error' in read) return read

  const value = read.argument.value
  if (typeof value !== 'string' || !READ_STATUSES.includes(value as (typeof READ_STATUSES)[number])) {
    return { error: `readStatus takes one of ${READ_STATUSES.join(', ')}` }
  }
  if (context.userId === null) return { filter: sql<boolean>`false` }

  // A series has read progress as soon as one of its books is opened, so a series
  // with no row at all is unread. That is why the three answers are about the row
  // rather than about its count: a row that says nought is still a series somebody
  // has started.
  const readCount = sql<number | null>`(select read_progress_series.read_count from read_progress_series
    where read_progress_series.user_id = ${context.userId} and read_progress_series.series_id = series.id)`
  const bookCount = sql<number>`(select count(*) from books counted where counted.series_id = series.id and counted.deleted_date is null)`

  const compare = sql<boolean>`${readCount} = ${bookCount}`
  const differ = sql<boolean>`${readCount} <> ${bookCount}`

  switch (value) {
    case 'UNREAD':
      return read.operator === 'is'
        ? { filter: sql<boolean>`${readCount} is null` }
        : { filter: sql<boolean>`${readCount} is not null` }
    case 'READ':
      return read.operator === 'is'
        ? { filter: compare }
        : { filter: sql<boolean>`(${differ} or ${readCount} is null)` }
    default:
      return read.operator === 'is'
        ? { filter: differ }
        : { filter: sql<boolean>`(${compare} or ${readCount} is null)` }
  }
}

/** The poster of a book: the type of the picture, whether it is the chosen one, or both. */
function posterOperator(node: unknown): ConditionResult {
  const read = readOperator('poster', node, EQUALITY)
  if ('error' in read) return read

  const value = read.argument.value
  if (!isRecord(value)) return { error: 'poster is and isNot need an object with a type, a selected flag, or both' }

  const type = value.type
  const selected = value.selected
  if (type === undefined && selected === undefined) return { filter: sql<boolean>`true` }
  if (type !== undefined && typeof type !== 'string') return { error: 'poster type must be a string' }
  if (selected !== undefined && typeof selected !== 'boolean') return { error: 'poster selected must be true or false' }

  const conditions: RawBuilder<boolean>[] = [sql<boolean>`owner_type = 'BOOK'`, sql<boolean>`owner_id = books.id`]
  if (type !== undefined) conditions.push(sql<boolean>`type = ${type}`)
  if (selected !== undefined) conditions.push(sql<boolean>`selected = ${selected ? 1 : 0}`)

  const match = sql<boolean>`exists (select 1 from thumbnails where ${sql.join(conditions, sql` and `)})`
  return { filter: read.operator === 'is' ? match : sql<boolean>`not (${match})` }
}

function anyOf(filters: RawBuilder<boolean>[]): ConditionFilter {
  return sql<boolean>`(${sql.join(filters, sql` or `)})`
}

function allOf(filters: RawBuilder<boolean>[]): ConditionFilter {
  return sql<boolean>`(${sql.join(filters, sql` and `)})`
}

/** The fields a book condition can name, and how each one is compared. */
function bookField(field: string, node: unknown, context: ConditionContext): ConditionResult {
  switch (field) {
    case 'libraryId':
      return equalityOperator(field, 'books.library_id', node, false)
    case 'seriesId':
      return equalityOperator(field, 'books.series_id', node, false)
    case 'readListId': {
      const read = readOperator(field, node, EQUALITY)
      if ('error' in read) return read
      const argument = textArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument

      const member = sql<boolean>`exists (select 1 from readlist_book where readlist_book.book_id = books.id and readlist_book.readlist_id = ${argument.value})`
      return { filter: read.operator === 'is' ? member : sql<boolean>`not (${member})` }
    }
    case 'deleted':
      return booleanOperator(
        field,
        (value) => sql<boolean>`books.deleted_date is ${value ? sql`not null` : sql`null`}`,
        node,
      )
    case 'oneShot':
      return booleanOperator(field, (value) => sql<boolean>`books.oneshot = ${value ? 1 : 0}`, node)
    case 'title':
      return stringOperator(field, 'book_metadata.title', node)
    case 'releaseDate':
      return dateOperator(field, 'book_metadata.release_date', node)
    case 'tag':
      return listOperator({ field, table: 'book_metadata_tag', owner: 'book_id', value: 'tag' }, 'books', node)
    case 'numberSort':
      return floatOperator(field, 'book_metadata.number_sort', node)
    case 'readStatus':
      return bookReadStatus(node, context)
    case 'mediaStatus': {
      const read = readOperator(field, node, EQUALITY)
      if ('error' in read) return read
      const argument = textArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument

      const comparison = sql<boolean>`media.status = ${argument.value}`
      return { filter: read.operator === 'is' ? comparison : sql<boolean>`not (${comparison})` }
    }
    case 'mediaProfile': {
      const read = readOperator(field, node, EQUALITY)
      if ('error' in read) return read
      const argument = textArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument

      const types = MEDIA_PROFILES[argument.value.toUpperCase()]
      if (types === undefined) return { error: `mediaProfile takes one of ${Object.keys(MEDIA_PROFILES).join(', ')}` }

      const comparison = sql<boolean>`media.media_type in (${sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      )})`
      return { filter: read.operator === 'is' ? comparison : sql<boolean>`not (${comparison})` }
    }
    case 'author':
      return authorOperator({ table: 'book_metadata_author', owner: 'book_id' }, 'books', node)
    case 'poster':
      return posterOperator(node)
    default:
      return { error: `${field} is not a field a book search knows` }
  }
}

/** An author, whose name and role are both optional and compared case-insensitively. */
function authorOperator(spec: { table: string; owner: string }, entity: string, node: unknown): ConditionResult {
  const read = readOperator('author', node, EQUALITY)
  if ('error' in read) return read

  const value = read.argument.value
  if (!isRecord(value)) return { error: 'author needs an object with a name, a role, or both' }

  const name = value.name
  const role = value.role
  if (name === undefined && role === undefined) return { filter: sql<boolean>`true` }
  if (name !== undefined && typeof name !== 'string') return { error: 'author name must be a string' }
  if (role !== undefined && typeof role !== 'string') return { error: 'author role must be a string' }

  const conditions: RawBuilder<boolean>[] = [
    sql<boolean>`${sql.ref(`${spec.table}.${spec.owner}`)} = ${sql.ref(`${entity}.id`)}`,
  ]
  if (name !== undefined) conditions.push(sql<boolean>`fold(${sql.ref(`${spec.table}.name`)}) = fold(${name})`)
  if (role !== undefined) conditions.push(sql<boolean>`fold(${sql.ref(`${spec.table}.role`)}) = fold(${role})`)

  const match = sql<boolean>`exists (select 1 from ${sql.ref(spec.table)} where ${sql.join(conditions, sql` and `)})`
  return { filter: read.operator === 'is' ? match : sql<boolean>`not (${match})` }
}

/** The fields a series condition can name, and how each one is compared. */
function seriesField(field: string, node: unknown, context: ConditionContext): ConditionResult {
  switch (field) {
    case 'libraryId':
      return equalityOperator(field, 'series.library_id', node, false)
    case 'collectionId': {
      const read = readOperator(field, node, EQUALITY)
      if ('error' in read) return read
      const argument = textArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument

      const member = sql<boolean>`exists (select 1 from collection_series where collection_series.series_id = series.id and collection_series.collection_id = ${argument.value})`
      return { filter: read.operator === 'is' ? member : sql<boolean>`not (${member})` }
    }
    case 'deleted':
      return booleanOperator(
        field,
        (value) => sql<boolean>`series.deleted_date is ${value ? sql`not null` : sql`null`}`,
        node,
      )
    case 'complete':
      return booleanOperator(
        field,
        (value) => {
          const bookCount = sql<number>`(select count(*) from books counted where counted.series_id = series.id and counted.deleted_date is null)`
          return value
            ? sql<boolean>`series_metadata.total_book_count is not null and series_metadata.total_book_count = ${bookCount}`
            : sql<boolean>`(series_metadata.total_book_count is null or series_metadata.total_book_count <> ${bookCount})`
        },
        node,
      )
    case 'oneShot':
      return booleanOperator(field, (value) => sql<boolean>`series.oneshot = ${value ? 1 : 0}`, node)
    case 'title':
      return stringOperator(field, 'series_metadata.title', node)
    case 'titleSort':
      return stringOperator(field, 'series_metadata.title_sort', node)
    case 'releaseDate':
      return dateOperator(field, 'book_metadata_aggregation.release_date', node)
    case 'tag':
      return listOperator(
        {
          field,
          table: 'series_metadata_tag',
          owner: 'series_id',
          value: 'tag',
          also: { table: 'book_metadata_aggregation_tag', owner: 'series_id', value: 'tag' },
        },
        'series',
        node,
      )
    case 'sharingLabel':
      return listOperator(
        { field, table: 'series_metadata_sharing', owner: 'series_id', value: 'label' },
        'series',
        node,
      )
    case 'genre':
      return listOperator({ field, table: 'series_metadata_genre', owner: 'series_id', value: 'genre' }, 'series', node)
    case 'publisher':
      return equalityOperator(field, 'series_metadata.publisher', node, true)
    case 'language':
      return equalityOperator(field, 'series_metadata.language', node, true)
    case 'ageRating':
      return numberOperator(field, 'series_metadata.age_rating', node)
    case 'readStatus':
      return seriesReadStatus(node, context)
    case 'seriesStatus': {
      const read = readOperator(field, node, EQUALITY)
      if ('error' in read) return read
      const argument = textArgument(field, read.operator, read.argument)
      if ('error' in argument) return argument

      const comparison = sql<boolean>`series_metadata.status = ${argument.value}`
      return { filter: read.operator === 'is' ? comparison : sql<boolean>`not (${comparison})` }
    }
    case 'author':
      // A series' authors are the ones its books carry, aggregated - which is what the
      // reference searches too, and not the series' own author rows.
      return authorOperator({ table: 'book_metadata_aggregation_author', owner: 'series_id' }, 'series', node)
    default:
      return { error: `${field} is not a field a series search knows` }
  }
}

/** Translate a book condition, or say why it cannot be one. */
export function bookCondition(condition: unknown, context: ConditionContext): ConditionResult {
  return translate(condition, context, bookField, 'book')
}

/** Translate a series condition, or say why it cannot be one. */
export function seriesCondition(condition: unknown, context: ConditionContext): ConditionResult {
  return translate(condition, context, seriesField, 'series')
}

function translate(
  condition: unknown,
  context: ConditionContext,
  field: (name: string, node: unknown, context: ConditionContext) => ConditionResult,
  kind: string,
): ConditionResult {
  if (!isRecord(condition)) return { error: `a ${kind} condition must be an object` }

  const names = Object.keys(condition)
  if (names.length === 0) return { error: `a ${kind} condition must name a field` }
  if (names.length > 1) return { error: `a ${kind} condition names one field, not ${names.join(', ')}` }

  const name = names[0] as string
  const node = condition[name]

  if (name === 'allOf' || name === 'anyOf') {
    if (!Array.isArray(node)) return { error: `${name} must be a list of conditions` }
    if (node.length === 0) return { error: `${name} must hold at least one condition` }

    const filters: RawBuilder<boolean>[] = []
    for (const entry of node) {
      const translated = translate(entry, context, field, kind)
      if ('error' in translated) return translated
      filters.push(translated.filter)
    }

    return { filter: name === 'allOf' ? allOf(filters) : anyOf(filters) }
  }

  return field(name, node, context)
}
