import { sql } from 'kysely'
import type { Migration } from '../migrate.js'

/**
 * A counter that moves whenever what a restricted user may see could have changed.
 *
 * Which series a user with an age or label restriction may see depends on every
 * series' library, age rating and sharing labels. Working that out reads all of
 * them, and it was done on every request - each page image of a book included.
 * The answer only changes when one of those rows does, so the triggers below count
 * such changes and the server keeps its answer until the count moves.
 *
 * Triggers rather than code at each write, because the writes are many and spread
 * out - the scan, the metadata refresh, the editing endpoints, an import - and one
 * missed would show a user something they were not to see.
 */
export const migration0018ContentVersion: Migration = {
  id: '0018_content_version',
  up: async (db) => {
    await sql`create table content_version (id integer primary key check (id = 1), version integer not null)`.execute(
      db,
    )
    await sql`insert into content_version (id, version) values (1, 0)`.execute(db)

    const bump = sql.raw('update content_version set version = version + 1 where id = 1;')
    const triggers: [name: string, event: string][] = [
      ['series__ai', 'after insert on series'],
      ['series__ad', 'after delete on series'],
      ['series__au', 'after update of library_id on series'],
      ['series_metadata__ai', 'after insert on series_metadata'],
      ['series_metadata__au', 'after update of age_rating on series_metadata'],
      ['series_metadata_sharing__ai', 'after insert on series_metadata_sharing'],
      ['series_metadata_sharing__ad', 'after delete on series_metadata_sharing'],
      ['series_metadata_sharing__au', 'after update on series_metadata_sharing'],
    ]
    for (const [name, event] of triggers) {
      await sql`create trigger ${sql.raw(`content_version__${name}`)} ${sql.raw(event)} begin ${bump} end`.execute(db)
    }
  },
}
