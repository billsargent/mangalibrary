import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

/**
 * Full-text search on SQLite FTS5, replacing Komga's Lucene index.
 *
 * The tables are external-content FTS5 indexes: the indexed columns mirror real
 * tables and synchronisation is done by triggers, so no indexing code is needed
 * on the write path.
 */
export const migration0009Search: Migration = {
  id: '0009_search',
  up: async (db) => {
    const tokenize = `tokenize = 'porter unicode61 remove_diacritics 2'`

    // ------------------------------------------------------------------ books
    await sql`
      create virtual table if not exists fts_books using fts5(
        title, isbn, book_id unindexed, content='book_metadata', ${sql.raw(tokenize)}
      )
    `.execute(db)
    await sql`create trigger if not exists book_metadata__ai after insert on book_metadata begin
      insert into fts_books(rowid, title, isbn, book_id) values (new.rowid, new.title, new.isbn, new.book_id);
    end`.execute(db)
    await sql`create trigger if not exists book_metadata__ad after delete on book_metadata begin
      insert into fts_books(fts_books, rowid, title, isbn, book_id) values('delete', old.rowid, old.title, old.isbn, old.book_id);
    end`.execute(db)
    await sql`create trigger if not exists book_metadata__au after update on book_metadata begin
      insert into fts_books(fts_books, rowid, title, isbn, book_id) values('delete', old.rowid, old.title, old.isbn, old.book_id);
      insert into fts_books(rowid, title, isbn, book_id) values (new.rowid, new.title, new.isbn, new.book_id);
    end`.execute(db)

    // ----------------------------------------------------------------- series
    await sql`
      create virtual table if not exists fts_series using fts5(
        title, publisher, series_id unindexed, content='series_metadata', ${sql.raw(tokenize)}
      )
    `.execute(db)
    await sql`create trigger if not exists series_metadata__ai after insert on series_metadata begin
      insert into fts_series(rowid, title, publisher, series_id) values (new.rowid, new.title, new.publisher, new.series_id);
    end`.execute(db)
    await sql`create trigger if not exists series_metadata__ad after delete on series_metadata begin
      insert into fts_series(fts_series, rowid, title, publisher, series_id) values('delete', old.rowid, old.title, old.publisher, old.series_id);
    end`.execute(db)
    await sql`create trigger if not exists series_metadata__au after update on series_metadata begin
      insert into fts_series(fts_series, rowid, title, publisher, series_id) values('delete', old.rowid, old.title, old.publisher, old.series_id);
      insert into fts_series(rowid, title, publisher, series_id) values (new.rowid, new.title, new.publisher, new.series_id);
    end`.execute(db)

    // ------------------------------------------------------------ collections
    await sql`
      create virtual table if not exists fts_collections using fts5(
        name, id unindexed, content='collections', ${sql.raw(tokenize)}
      )
    `.execute(db)
    await sql`create trigger if not exists collections__ai after insert on collections begin
      insert into fts_collections(rowid, name, id) values (new.rowid, new.name, new.id);
    end`.execute(db)
    await sql`create trigger if not exists collections__ad after delete on collections begin
      insert into fts_collections(fts_collections, rowid, name, id) values('delete', old.rowid, old.name, old.id);
    end`.execute(db)
    await sql`create trigger if not exists collections__au after update on collections begin
      insert into fts_collections(fts_collections, rowid, name, id) values('delete', old.rowid, old.name, old.id);
      insert into fts_collections(rowid, name, id) values (new.rowid, new.name, new.id);
    end`.execute(db)

    // -------------------------------------------------------------- readlists
    await sql`
      create virtual table if not exists fts_readlists using fts5(
        name, id unindexed, content='readlists', ${sql.raw(tokenize)}
      )
    `.execute(db)
    await sql`create trigger if not exists readlists__ai after insert on readlists begin
      insert into fts_readlists(rowid, name, id) values (new.rowid, new.name, new.id);
    end`.execute(db)
    await sql`create trigger if not exists readlists__ad after delete on readlists begin
      insert into fts_readlists(fts_readlists, rowid, name, id) values('delete', old.rowid, old.name, old.id);
    end`.execute(db)
    await sql`create trigger if not exists readlists__au after update on readlists begin
      insert into fts_readlists(fts_readlists, rowid, name, id) values('delete', old.rowid, old.name, old.id);
      insert into fts_readlists(rowid, name, id) values (new.rowid, new.name, new.id);
    end`.execute(db)

    // ---------------------------------------------------- aggregated authors
    await sql`
      create virtual table if not exists fts_authors using fts5(
        name, series_id unindexed, content='book_metadata_aggregation_author', ${sql.raw(tokenize)}
      )
    `.execute(db)
    await sql`create trigger if not exists book_metadata_aggregation_author__ai after insert on book_metadata_aggregation_author begin
      insert into fts_authors(rowid, name, series_id) values (new.rowid, new.name, new.series_id);
    end`.execute(db)
    await sql`create trigger if not exists book_metadata_aggregation_author__ad after delete on book_metadata_aggregation_author begin
      insert into fts_authors(fts_authors, rowid, name, series_id) values('delete', old.rowid, old.name, old.series_id);
    end`.execute(db)
    await sql`create trigger if not exists book_metadata_aggregation_author__au after update on book_metadata_aggregation_author begin
      insert into fts_authors(fts_authors, rowid, name, series_id) values('delete', old.rowid, old.name, old.series_id);
      insert into fts_authors(rowid, name, series_id) values (new.rowid, new.name, new.series_id);
    end`.execute(db)

    // Index anything already present.
    await sql`insert into fts_books(fts_books) values('rebuild')`.execute(db)
    await sql`insert into fts_series(fts_series) values('rebuild')`.execute(db)
    await sql`insert into fts_collections(fts_collections) values('rebuild')`.execute(db)
    await sql`insert into fts_readlists(fts_readlists) values('rebuild')`.execute(db)
    await sql`insert into fts_authors(fts_authors) values('rebuild')`.execute(db)
  },
}
