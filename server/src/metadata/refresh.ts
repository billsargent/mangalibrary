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

import { bookFilePath, findBookRecord } from '../content/files.js'
import type { DB } from '../db/schema.js'
import { addBookToReadList } from '../organisation/membership.js'
import { isbnBarcodePatch } from './barcode.js'
import { comicInfoBookPatch } from './comicinfo.js'
import { readBookDocuments, type BookDocuments } from './document.js'
import { epubMetadata } from './epub.js'
import {
  BOOK_METADATA_CAPABILITIES,
  applyBookPatches,
  isEmptyUpdate,
  type Author,
  type BookMetadataCapability,
  type BookMetadataPatch,
  type BookMetadataState,
  type BookMetadataUpdate,
  type ReadListEntry,
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
  /** The read lists the book was put in, by name. */
  readLists: string[]
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
    .select(['import_comic_info_book', 'import_epub_book', 'import_comic_info_read_list', 'import_barcode_isbn'])
    .where('id', '=', record.libraryId)
    .executeTakeFirst()
  if (!library) throw new Error(`library ${record.libraryId} does not exist`)

  const imported = new Set<BookMetadataCapability>(options.capabilities ?? BOOK_METADATA_CAPABILITIES)
  const importsDocuments = library.import_comic_info_book === 1 || library.import_epub_book === 1
  const importsBarcode = library.import_barcode_isbn === 1 && imported.has('ISBN')
  if (!importsDocuments && !importsBarcode) {
    return {
      status: 'skipped',
      changed: [],
      readLists: [],
      reason: 'the library does not import a book\u2019s metadata documents',
    }
  }

  const path = options.path ?? (await bookFilePath(record))
  if (path === null) return { status: 'skipped', changed: [], readLists: [], reason: 'the file is not there' }

  const patches: BookMetadataPatch[] = []

  // The barcode is read first, so that an ISBN a document states wins over one
  // read off a printed page: a document is the more specific statement of the two.
  // The reference's provider order is whatever Spring hands it, which is not
  // something to copy.
  if (importsBarcode) {
    const barcode = await isbnBarcodePatch(path)
    if (barcode !== null) patches.push(barcode)
  }

  let documents: BookDocuments | null = null
  let documentsReason: string | null = null
  if (importsDocuments) {
    const read = await readBookDocuments(path)
    if (read.status === 'failed') return { status: 'failed', changed: [], readLists: [], reason: read.reason }
    if (read.status === 'ok') documents = read.documents
    else documentsReason = read.reason
  }

  // The documents are applied in the reference's provider order, so that where two
  // of them disagree the later one wins.
  if (documents !== null) {
    if (library.import_comic_info_book === 1 && documents.comicInfo !== null) {
      patches.push(comicInfoBookPatch(documents.comicInfo))
    }
    if (library.import_epub_book === 1 && documents.packageDocument !== null) {
      patches.push(epubMetadata(documents.packageDocument).book)
    }
  }

  if (patches.length === 0) {
    return {
      status: 'skipped',
      changed: [],
      readLists: [],
      reason:
        documentsReason ??
        (importsDocuments
          ? 'the library does not import the documents this book carries'
          : 'no barcode was found to read'),
    }
  }

  const state = await metadataState(db, bookId)
  if (state === null) return { status: 'skipped', changed: [], readLists: [], reason: 'the book has no metadata row' }

  const update = applyBookPatches(state, patches, options.capabilities)
  const changed = Object.keys(update.values).map((column) => VALUE_NAMES[column] ?? column)
  if (update.authors !== undefined) changed.push('authors')
  if (update.tags !== undefined) changed.push('tags')
  if (update.links !== undefined) changed.push('links')

  if (!isEmptyUpdate(update)) {
    const now = new Date().toISOString()
    await writeUpdate(db, bookId, update, now)
  }

  // Read lists are organisation rather than metadata: a document saying a book
  // belongs to a story arc does not depend on the book's own fields being written,
  // and a locked title does not stop it - which is how the reference treats them.
  const readLists =
    library.import_comic_info_read_list === 1
      ? await addReadLists(
          db,
          bookId,
          patches.flatMap((patch) => patch.readLists ?? []),
        )
      : []

  if (changed.length === 0 && readLists.length === 0) {
    return { status: 'unchanged', changed: [], readLists: [], reason: null }
  }
  return { status: 'changed', changed, readLists, reason: null }
}

/** Put a book in each read list a document names, and report the ones it was put in. */
async function addReadLists(db: Kysely<DB>, bookId: string, entries: readonly ReadListEntry[]): Promise<string[]> {
  const added: string[] = []
  for (const entry of entries) {
    const outcome = await addBookToReadList(db, entry.name, bookId, entry.number)
    if (outcome !== 'present') added.push(entry.name)
  }
  return added
}
