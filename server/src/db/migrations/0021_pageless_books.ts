import type { Migration } from '../migrate.js'

/**
 * Archives recorded as ready with no pages are analysed again.
 *
 * An archive with nothing in it that is a picture used to be recorded as a ready
 * book of no pages, which listed it as readable when it could not be opened. It
 * is an error now, as it is in the reference. Marking these outdated is what a
 * scan does to a file that changed: the next scan analyses them again, and they
 * come out as what they are.
 */
export const migration0021PagelessBooks: Migration = {
  id: '0021_pageless_books',
  up: async (db) => {
    await db
      .updateTable('media')
      .set({ status: 'OUTDATED' })
      .where('media_type', 'in', ['application/zip', 'application/x-rar-compressed'])
      .where('status', '=', 'READY')
      .where('page_count', '=', 0)
      .execute()
  },
}
