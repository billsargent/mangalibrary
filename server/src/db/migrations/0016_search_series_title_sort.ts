import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

/**
 * The series index also covers the title a list shows.
 *
 * A series is titled twice: the title, and the title sort, which is the one a list is
 * ordered and often displayed by. Migration 0009 indexed the first only, so searching
 * for what a list shows found nothing when the two differed. The reference indexes
 * both, so this does too.
 *
 * An FTS5 table cannot gain a column, so it is dropped and built again, with its
 * triggers, and the content is indexed from scratch - which is cheap and is what
 * `rebuild` is for.
 */
export const migration0016SearchSeriesTitleSort: Migration = {
  id: '0016_search_series_title_sort',
  up: async (db) => {
    await sql`drop trigger if exists series_metadata__ai`.execute(db)
    await sql`drop trigger if exists series_metadata__ad`.execute(db)
    await sql`drop trigger if exists series_metadata__au`.execute(db)
    await sql`drop table if exists fts_series`.execute(db)

    await sql`
      create virtual table fts_series using fts5(
        title, title_sort, publisher, series_id unindexed, content='series_metadata',
        tokenize = 'porter unicode61 remove_diacritics 2'
      )
    `.execute(db)

    await sql`create trigger series_metadata__ai after insert on series_metadata begin
      insert into fts_series(rowid, title, title_sort, publisher, series_id)
      values (new.rowid, new.title, new.title_sort, new.publisher, new.series_id);
    end`.execute(db)
    await sql`create trigger series_metadata__ad after delete on series_metadata begin
      insert into fts_series(fts_series, rowid, title, title_sort, publisher, series_id)
      values('delete', old.rowid, old.title, old.title_sort, old.publisher, old.series_id);
    end`.execute(db)
    await sql`create trigger series_metadata__au after update on series_metadata begin
      insert into fts_series(fts_series, rowid, title, title_sort, publisher, series_id)
      values('delete', old.rowid, old.title, old.title_sort, old.publisher, old.series_id);
      insert into fts_series(rowid, title, title_sort, publisher, series_id)
      values (new.rowid, new.title, new.title_sort, new.publisher, new.series_id);
    end`.execute(db)

    await sql`insert into fts_series(fts_series) values('rebuild')`.execute(db)
  },
}
