import type { Migration } from '../migrate.js'

export const migration0002Libraries: Migration = {
  id: '0002_libraries',
  up: async (db) => {
    await db.schema
      .createTable('libraries')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('root', 'text', (col) => col.notNull())
      .addColumn('import_comic_info_book', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_comic_info_series', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_comic_info_collection', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_comic_info_read_list', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_comic_info_series_append_volume', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_epub_book', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_epub_series', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_mylar_series', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_local_artwork', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('import_barcode_isbn', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('scan_force_modified_time', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('scan_on_startup', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('scan_interval', 'text', (col) => col.notNull().defaultTo('EVERY_6H'))
      .addColumn('scan_cbx', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('scan_pdf', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('scan_epub', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('scan_directory_exclusions', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('repair_extensions', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('convert_to_cbz', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('empty_trash_after_scan', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('series_cover', 'text', (col) => col.notNull().defaultTo('FIRST'))
      .addColumn('hash_files', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('hash_pages', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('hash_koreader', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('analyze_dimensions', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('oneshots_directory', 'text')
      .addColumn('unavailable_date', 'text')
      .addColumn('created_date', 'text', (col) => col.notNull())
      .addColumn('last_modified_date', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createTable('library_exclusions')
      .ifNotExists()
      .addColumn('library_id', 'text', (col) => col.notNull().references('libraries.id').onDelete('cascade'))
      .addColumn('exclusion', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk__library_exclusions', ['library_id', 'exclusion'])
      .execute()

    await db.schema.createIndex('idx__libraries__name').ifNotExists().on('libraries').columns(['name']).execute()
  },
}
