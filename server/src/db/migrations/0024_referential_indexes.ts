import { sql } from 'kysely'

import type { Migration } from '../migrate.js'

/**
 * Indexes for listing the tags and the authors a library has.
 *
 * A filter panel shows every tag there is, and every writer. Those are kept a row to
 * a book - 400,000 rows of each for 200,000 books - and the only index was by book,
 * so finding the 600 different tags meant reading all of the rows: about a second.
 * With an index that starts with the value, the database steps from one value to
 * the next, and listing everything there is costs by how many tags there are and
 * not by how many books have them: 2 ms. (Asked about one library of several, the
 * rows of that library's books are still read; see `routes/referential.ts`.)
 */
export const migration0024ReferentialIndexes: Migration = {
  id: '0024_referential_indexes',
  up: async (db) => {
    await sql`
      create index if not exists idx__book_metadata_tag__tag
      on book_metadata_tag (tag, book_id)
    `.execute(db)
    await sql`
      create index if not exists idx__book_metadata_author__role_name
      on book_metadata_author (role, name, book_id)
    `.execute(db)
  },
}
