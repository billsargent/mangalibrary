import { sql } from 'kysely'

import type { Migration } from '../migrate.js'

/**
 * A key to sort series by: the title they are sorted under, lower-case and without
 * accents.
 *
 * Sorted by `title_sort` itself, SQLite compares bytes: every capital before every
 * small letter, and `Élan` after `zed`. The reference sorts with a Unicode collation,
 * which better-sqlite3 cannot register, and sorting by an expression would lose the
 * index that keeps a page of series cheap on a large library (migration 0023). So the
 * folded title is kept in a column of its own - written by triggers whenever a title
 * is, with the same `fold` the search uses - and indexed with the series id that
 * breaks ties.
 *
 * The triggers call `fold`, which the server registers on every connection it opens.
 * A tool that writes `series_metadata` without it would be refused; reading needs
 * nothing.
 */
export const migration0027TitleSortKey: Migration = {
  id: '0027_title_sort_key',
  up: async (db) => {
    const statements = [
      // The search index of series is kept by triggers too, and its update trigger
      // fired on any change to a row - including the key's own, written while the row
      // was being inserted and before the search index had it, which corrupts the
      // index. It is narrowed to the columns it indexes, which it only ever needed.
      sql`drop trigger if exists series_metadata__au`,
      sql`create trigger series_metadata__au after update of title, title_sort, publisher, series_id on series_metadata begin
        insert into fts_series(fts_series, rowid, title, title_sort, publisher, series_id)
        values('delete', old.rowid, old.title, old.title_sort, old.publisher, old.series_id);
        insert into fts_series(rowid, title, title_sort, publisher, series_id)
        values (new.rowid, new.title, new.title_sort, new.publisher, new.series_id);
      end`,
      sql`alter table series_metadata add column title_sort_key text not null default ''`,
      sql`update series_metadata set title_sort_key = coalesce(fold(title_sort), '')`,
      sql`create trigger if not exists series_metadata__title_sort_key__ai after insert on series_metadata begin
        update series_metadata set title_sort_key = coalesce(fold(new.title_sort), '') where series_id = new.series_id; end`,
      sql`create trigger if not exists series_metadata__title_sort_key__au after update of title_sort on series_metadata begin
        update series_metadata set title_sort_key = coalesce(fold(new.title_sort), '') where series_id = new.series_id; end`,
      sql`drop index if exists idx__series_metadata__title_sort`,
      sql`create index if not exists idx__series_metadata__title_sort_key on series_metadata (title_sort_key, series_id)`,
    ]
    for (const statement of statements) await statement.execute(db)
  },
}
