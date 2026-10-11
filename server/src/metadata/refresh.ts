/**
 * Refreshing a book's metadata from the file itself.
 *
 * This is the step that makes a scanned library worth looking at: the file is
 * opened, whatever documents it carries are read, and what they say is applied to
 * the metadata tables - subject to the per-field locks, so a field a user has
 * edited by hand survives.
 *
 * Reading a book twice is deliberate. Analysis opens the container to count pages;
 * this opens it again to read documents out of it. The alternative is threading an
 * open container through both, which would tie analysis to metadata for the sake
 * of one file read.
 */

import type { Kysely } from 'kysely'

import { bookFilePath, findBookRecord } from '../books/files.js'
import type { DB } from '../db/schema.js'
import { openBook, type BookContents } from '../media/index.js'
import { comicInfoBookPatch, comicInfoEntry } from './comicinfo.js'
import {
  applyBookPatch,
  isEmptyUpdate,
  type Author,
  type BookMetadataCapability,
  type BookMetadataPatch,
  type BookMetadataState,
  type BookMetadataUpdate,
  type WebLink,
} from './patches.js'

/**
 * What a refresh did.
 *
 * `skipped` means nothing was read - a library that does not import this
 * document, a book that does not carry one, a file that is no longer there -
 * `unchanged` means it was read and said what was already stored, and `failed`
 * means reading or parsing did not work. A failure is reported rather than
 * thrown: a malformed document must not fail the analysis that found it.
 */
export type MetadataRefreshStatus = 'changed' | 'unchanged' | 'skipped' | 'failed'

export interface MetadataRefreshResult {
  status: MetadataRefreshStatus
  /** The fields written, named as the API names them. */
  changed: string[]
  /** Why nothing was read or written, when nothing was. */
  reason: string | null
}

/** The columns of the metadata update, under the names a caller recognises. */
const VALUE_NAMES: Record<string, string> = {
  title: 'title',
  summary: 'summary',
  number: 'number',
  number_sort: 'numberSort',
  release_date: 'releaseDate',
  isbn: 'isbn',
}

type DocumentRead = { status: 'ok'; xml: string } | { status: 'skipped' | 'failed'; reason: string }

/** Read `ComicInfo.xml` out of a book, without ever throwing. */
async function readComicInfo(path: string): Promise<DocumentRead> {
  let book: BookContents | null = null
  try {
    book = await openBook(path)
    const entry = comicInfoEntry(book.files)
    if (entry === null) return { status: 'skipped', reason: 'the book carries no ComicInfo.xml' }

    return { status: 'ok', xml: (await book.readResource(entry)).toString('utf8') }
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message }
  } finally {
    book?.close()
  }
}

/** A book's stored metadata and locks, or null when it has no metadata row. */
async function metadataState(db: Kysely<DB>, bookId: string): Promise<BookMetadataState | null> {
  const row = await db.selectFrom('book_metadata').selectAll().where('book_id', '=', bookId).executeTakeFirst()
  if (!row) return null

  const authors = await db
    .selectFrom('book_metadata_author')
    .select(['name', 'role'])
    .where('book_id', '=', bookId)
    .execute()
  const tags = await db.selectFrom('book_metadata_tag').select('tag').where('book_id', '=', bookId).execute()
  const links = await db
    .selectFrom('book_metadata_link')
    .select(['label', 'url'])
    .where('book_id', '=', bookId)
    .execute()

  return {
    title: row.title,
    summary: row.summary,
    number: row.number,
    numberSort: row.number_sort,
    releaseDate: row.release_date,
    isbn: row.isbn,
    authors: authors.map((author) => ({ name: author.name, role: author.role })),
    tags: tags.map((tag) => tag.tag),
    links: links.map((link) => ({ label: link.label, url: link.url })),
    locks: {
      title: row.title_lock === 1,
      summary: row.summary_lock === 1,
      number: row.number_lock === 1,
      numberSort: row.number_sort_lock === 1,
      releaseDate: row.release_date_lock === 1,
      isbn: row.isbn_lock === 1,
      authors: row.authors_lock === 1,
      tags: row.tags_lock === 1,
      links: row.links_lock === 1,
    },
  }
}

/** Distinct rows for a child table, because its primary key is the pair. */
function distinct<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const value = key(row)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

async function writeUpdate(db: Kysely<DB>, bookId: string, update: BookMetadataUpdate, now: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('book_metadata')
      .set({ ...update.values, last_modified_date: now })
      .where('book_id', '=', bookId)
      .execute()

    if (update.authors !== undefined) {
      await trx.deleteFrom('book_metadata_author').where('book_id', '=', bookId).execute()
      const rows = distinct(update.authors, (author: Author) => `${author.role}\u0000${author.name}`)
      if (rows.length > 0) {
        await trx
          .insertInto('book_metadata_author')
          .values(rows.map((author) => ({ book_id: bookId, name: author.name, role: author.role })))
          .execute()
      }
    }

    if (update.tags !== undefined) {
      await trx.deleteFrom('book_metadata_tag').where('book_id', '=', bookId).execute()
      if (update.tags.length > 0) {
        await trx
          .insertInto('book_metadata_tag')
          .values(update.tags.map((tag) => ({ book_id: bookId, tag })))
          .execute()
      }
    }

    if (update.links !== undefined) {
      await trx.deleteFrom('book_metadata_link').where('book_id', '=', bookId).execute()
      const rows = distinct(update.links, (link: WebLink) => `${link.label}\u0000${link.url}`)
      if (rows.length > 0) {
        await trx
          .insertInto('book_metadata_link')
          .values(rows.map((link) => ({ book_id: bookId, label: link.label, url: link.url })))
          .execute()
      }
    }
  })
}

/**
 * Read a book's metadata documents and apply what they say.
 *
 * The book's file is taken from the row, unless the caller already has it - an
 * analysis in progress knows the path it just read - and is confined to the
 * library root either way.
 */
export async function refreshBookMetadata(
  db: Kysely<DB>,
  bookId: string,
  options: { path?: string; capabilities?: readonly BookMetadataCapability[] } = {},
): Promise<MetadataRefreshResult> {
  const record = await findBookRecord(db, bookId)
  if (record === null) throw new Error(`book ${bookId} does not exist`)

  const library = await db
    .selectFrom('libraries')
    .select('import_comic_info_book')
    .where('id', '=', record.libraryId)
    .executeTakeFirst()
  if (!library) throw new Error(`library ${record.libraryId} does not exist`)
  if (library.import_comic_info_book !== 1) {
    return { status: 'skipped', changed: [], reason: 'the library does not import ComicInfo metadata' }
  }

  const path = options.path ?? (await bookFilePath(record))
  if (path === null) return { status: 'skipped', changed: [], reason: 'the file is not there' }

  const read = await readComicInfo(path)
  if (read.status !== 'ok') return { status: read.status, changed: [], reason: read.reason }

  const patch: BookMetadataPatch = comicInfoBookPatch(read.xml)
  const state = await metadataState(db, bookId)
  if (state === null) return { status: 'skipped', changed: [], reason: 'the book has no metadata row' }

  const update = applyBookPatch(state, patch, options.capabilities)
  if (isEmptyUpdate(update)) return { status: 'unchanged', changed: [], reason: null }

  const now = new Date().toISOString()
  await writeUpdate(db, bookId, update, now)

  const changed = Object.keys(update.values).map((column) => VALUE_NAMES[column] ?? column)
  if (update.authors !== undefined) changed.push('authors')
  if (update.tags !== undefined) changed.push('tags')
  if (update.links !== undefined) changed.push('links')

  return { status: 'changed', changed, reason: null }
}
