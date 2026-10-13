import type { Migration } from '../migrate.js'

/**
 * PDFs are analysed again, because their pages are now drawn larger.
 *
 * A PDF's pages were drawn at the size of the paper, and that size was what
 * analysis recorded for each page. They are now drawn at 1600 pixels on the
 * longer side, and a reader that lays a page out from the recorded size would
 * lay it out for an image a third as large as the one it is sent. Marking the
 * media outdated is what a scan does to a file that changed: the next scan
 * analyses these again, which for a PDF no longer draws anything.
 */
export const migration0019PdfPageSize: Migration = {
  id: '0019_pdf_page_size',
  up: async (db) => {
    await db
      .updateTable('media')
      .set({ status: 'OUTDATED' })
      .where('media_type', '=', 'application/pdf')
      .where('status', '=', 'READY')
      .execute()
  },
}
