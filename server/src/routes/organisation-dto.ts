/**
 * DTOs for collections and read lists.
 *
 * `filtered` exists in the spec because Komga supports *dynamic* collections and
 * read lists defined by a saved search. We do not model saved searches, so the
 * flag is always false and the id lists are always the source of truth. Full CRUD
 * for these resources lands with the organisation endpoints.
 */

export interface CollectionDto {
  id: string
  name: string
  ordered: boolean
  seriesIds: string[]
  createdDate: string
  lastModifiedDate: string
  filtered: boolean
}

export interface ReadListDto {
  id: string
  name: string
  summary: string
  ordered: boolean
  bookIds: string[]
  createdDate: string
  lastModifiedDate: string
  filtered: boolean
}

export interface CollectionRow {
  id: string
  name: string
  ordered: number
  created_date: string
  last_modified_date: string
}

export interface ReadListRow {
  id: string
  name: string
  summary: string
  ordered: number
  created_date: string
  last_modified_date: string
}

export function toCollectionDto(row: CollectionRow, seriesIds: string[]): CollectionDto {
  return {
    id: row.id,
    name: row.name,
    ordered: row.ordered === 1,
    seriesIds,
    createdDate: row.created_date,
    lastModifiedDate: row.last_modified_date,
    filtered: false,
  }
}

export function toReadListDto(row: ReadListRow, bookIds: string[]): ReadListDto {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    ordered: row.ordered === 1,
    bookIds,
    createdDate: row.created_date,
    lastModifiedDate: row.last_modified_date,
    filtered: false,
  }
}
