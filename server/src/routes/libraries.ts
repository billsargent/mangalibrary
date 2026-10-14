import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { canAccessLibrary } from '../auth/access.js'
import { requireAdmin, requireAuth } from '../auth/session.js'
import { announceLibrary } from '../content-events.js'
import type { DB } from '../db/schema.js'
import type { EventBus } from '../events.js'
import type { FetchJson } from '../http.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { insideRootOnDisk } from '../media/scan.js'
import { nextTsid } from '../tsid.js'
import { toLibraryDto, type LibraryDto, type LibraryRow } from './dto.js'
import { booleanParam } from './query.js'

export interface RouteOptions {
  db: Kysely<DB>
  /** Fan-out of changes to the clients watching for them. */
  events: EventBus
  /** Reads a JSON document from a URL, for the endpoints that show something hosted elsewhere. */
  fetchJson: FetchJson
  /** Where the announcements feed lives, if anywhere. */
  announcementsUrl: string | null
  /** Where release notes live, if anywhere. */
  releasesUrl: string | null
  /** Where the fonts offered to the EPUB reader live. */
  fontsDir: string
  /** Port the server is listening on, as reported by the settings endpoint. */
  port?: number
  /** Port the configuration asks for, when it asks for one at all. */
  configuredPort?: number | null
}

const BOOLEAN_FIELDS: Record<string, keyof LibraryRow> = {
  importComicInfoBook: 'import_comic_info_book',
  importComicInfoSeries: 'import_comic_info_series',
  importComicInfoCollection: 'import_comic_info_collection',
  importComicInfoReadList: 'import_comic_info_read_list',
  importComicInfoSeriesAppendVolume: 'import_comic_info_series_append_volume',
  importEpubBook: 'import_epub_book',
  importEpubSeries: 'import_epub_series',
  importMylarSeries: 'import_mylar_series',
  importLocalArtwork: 'import_local_artwork',
  importBarcodeIsbn: 'import_barcode_isbn',
  scanForceModifiedTime: 'scan_force_modified_time',
  scanOnStartup: 'scan_on_startup',
  scanCbx: 'scan_cbx',
  scanPdf: 'scan_pdf',
  scanEpub: 'scan_epub',
  repairExtensions: 'repair_extensions',
  convertToCbz: 'convert_to_cbz',
  emptyTrashAfterScan: 'empty_trash_after_scan',
  hashFiles: 'hash_files',
  hashPages: 'hash_pages',
  hashKoreader: 'hash_koreader',
  analyzeDimensions: 'analyze_dimensions',
}

function scalarFields(body: Record<string, unknown>, target: Record<string, unknown>): void {
  for (const [apiName, column] of Object.entries(BOOLEAN_FIELDS)) {
    if (apiName in body) target[column] = body[apiName] ? 1 : 0
  }
  if ('name' in body && typeof body.name === 'string') target.name = body.name
  if ('root' in body && typeof body.root === 'string') target.root = body.root
  if ('scanInterval' in body && typeof body.scanInterval === 'string') target.scan_interval = body.scanInterval
  if ('seriesCover' in body && typeof body.seriesCover === 'string') target.series_cover = body.seriesCover
  if ('oneshotsDirectory' in body) {
    target.oneshots_directory = typeof body.oneshotsDirectory === 'string' ? body.oneshotsDirectory : null
  }
  if ('scanDirectoryExclusions' in body && Array.isArray(body.scanDirectoryExclusions)) {
    target.scan_directory_exclusions = JSON.stringify(body.scanDirectoryExclusions.map(String))
  }
}

async function replaceExclusions(db: Kysely<DB>, libraryId: string, values: unknown): Promise<void> {
  if (!Array.isArray(values)) return
  await db.deleteFrom('library_exclusions').where('library_id', '=', libraryId).execute()
  const rows = values.map(String).filter((value) => value.trim() !== '')
  if (rows.length > 0) {
    await db
      .insertInto('library_exclusions')
      .values(rows.map((exclusion) => ({ library_id: libraryId, exclusion })))
      .execute()
  }
}

/**
 * Why a library cannot be what was asked for, or null when it can.
 *
 * The reference refuses the same four things, and for the same reasons. A root
 * that is not there scans as an empty library, which soft-deletes whatever it
 * held. Two libraries of one name cannot be told apart in a list. And a root
 * inside another library's - or around it - puts the same files in two libraries,
 * each of which then scans, analyses and may rewrite them.
 */
export async function libraryProblem(
  db: Kysely<DB>,
  wanted: { name: string; root: string },
  exceptId?: string,
  check: { name: boolean; root: boolean } = { name: true, root: true },
): Promise<string | null> {
  if (check.root) {
    const info = await stat(wanted.root).catch(() => null)
    if (info === null) return `Library root folder does not exist: ${wanted.root}`
    if (!info.isDirectory()) return `Library root folder is not a folder: ${wanted.root}`
  }

  const others = (await db.selectFrom('libraries').select(['id', 'name', 'root']).execute()).filter(
    (library) => library.id !== exceptId,
  )
  if (check.name && others.some((library) => library.name === wanted.name)) return 'Library name already exists'
  if (!check.root) return null

  for (const other of others) {
    // As the disk spells them: the same folder typed two ways is the same folder.
    if (await insideRootOnDisk(other.root, wanted.root)) {
      return `Library path ${wanted.root} is a child of existing library ${other.name}: ${other.root}`
    }
    if (await insideRootOnDisk(wanted.root, other.root)) {
      return `Library path ${wanted.root} is a parent of existing library ${other.name}: ${other.root}`
    }
  }
  return null
}

/** The settings whose change means what a scan found is no longer what a scan would find. */
const RESCAN_ON_CHANGE = [
  'root',
  'oneshots_directory',
  'scan_cbx',
  'scan_pdf',
  'scan_epub',
  'scan_force_modified_time',
  'scan_directory_exclusions',
] as const

/**
 * The switches that ask for work on what is already in the library. That work is
 * queued by the scan, for the books that still need it, so turning one on asks
 * for a scan - which over an unchanged library looks at folder dates and no more.
 */
const WORK_WHEN_SWITCHED_ON = ['hash_files', 'hash_pages', 'hash_koreader', 'convert_to_cbz', 'repair_extensions'] as const

function currentUser(req: FastifyRequest) {
  const user = req.user
  if (!user) throw new Error('unauthenticated')
  return user
}

export async function registerLibraryRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

  /**
   * Queue a scan of a library.
   *
   * A library is nothing until it has been scanned, so adding one, or pointing one
   * at another folder, asks for a scan in the same breath. The reference does the
   * same and its UI relies on it: there is no "now scan it" step after the form.
   */
  const queueScan = (libraryId: string, scanDeep = false) =>
    enqueueJob(db, {
      type: 'ScanLibrary',
      uniqueKey: `SCANLIBRARY_${libraryId}`,
      priority: JOB_PRIORITY.HIGHEST,
      payload: { libraryId, scanDeep },
    })

  app.get('/api/v1/libraries', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req)
    const rows = await db.selectFrom('libraries').selectAll().orderBy('name').execute()
    return rows.filter((row) => canAccessLibrary(user, row.id)).map((row) => toLibraryDto(row as unknown as LibraryRow))
  })

  app.post('/api/v1/libraries', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const root = typeof body.root === 'string' ? body.root.trim() : ''
    if (!name || !root) {
      return reply.code(400).send({ validationErrors: { name: 'must not be blank', root: 'must not be blank' } })
    }
    const problem = await libraryProblem(db, { name, root })
    if (problem !== null) return reply.code(400).send({ message: problem })

    const now = new Date().toISOString()
    const values: Record<string, unknown> = { id: nextTsid(), name, root, created_date: now, last_modified_date: now }
    scalarFields(body, values)
    await db
      .insertInto('libraries')
      .values(values as never)
      .execute()
    await replaceExclusions(db, values.id as string, body.scanDirectoryExclusions)

    const row = await db
      .selectFrom('libraries')
      .selectAll()
      .where('id', '=', values.id as string)
      .executeTakeFirstOrThrow()
    announceLibrary(opts.events, 'LibraryAdded', values.id as string)
    await queueScan(values.id as string)
    return toLibraryDto(row as unknown as LibraryRow)
  })

  app.get<{ Params: { libraryId: string } }>(
    '/api/v1/libraries/:libraryId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = currentUser(req)
      if (!canAccessLibrary(user, req.params.libraryId)) return reply.code(403).send({ message: 'Forbidden' })
      const row = await db.selectFrom('libraries').selectAll().where('id', '=', req.params.libraryId).executeTakeFirst()
      if (!row) return reply.code(404).send({ message: 'Library not found' })
      return toLibraryDto(row as unknown as LibraryRow)
    },
  )

  // PUT is the reference's older form of the same change, deprecated there in favour of
  // PATCH and kept for the clients that still send it.
  app.route<{ Params: { libraryId: string } }>({
    method: ['PATCH', 'PUT'],
    url: '/api/v1/libraries/:libraryId',
    preHandler: requireAdmin,
    handler: async (req, reply) => {
      const existing = await db
        .selectFrom('libraries')
        .selectAll()
        .where('id', '=', req.params.libraryId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Library not found' })

      const body = (req.body ?? {}) as Record<string, unknown>
      const values: Record<string, unknown> = { last_modified_date: new Date().toISOString() }
      scalarFields(body, values)

      // Only what is being changed is checked: a library whose folder has gone
      // missing can still be renamed and have its other settings edited.
      const name = typeof values.name === 'string' ? values.name.trim() : existing.name
      const root = typeof values.root === 'string' ? values.root.trim() : existing.root
      if (name !== existing.name || root !== existing.root) {
        if (!name || !root) {
          return reply.code(400).send({ validationErrors: { name: 'must not be blank', root: 'must not be blank' } })
        }
        const problem = await libraryProblem(db, { name, root }, existing.id, {
          name: name !== existing.name,
          root: root !== existing.root,
        })
        if (problem !== null) return reply.code(400).send({ message: problem })
        values.name = name
        values.root = root
      }

      await db
        .updateTable('libraries')
        .set(values as never)
        .where('id', '=', req.params.libraryId)
        .execute()
      await replaceExclusions(db, req.params.libraryId, body.scanDirectoryExclusions)
      announceLibrary(opts.events, 'LibraryChanged', req.params.libraryId)
      const before = existing as unknown as Record<string, unknown>
      const changed = (column: string) => column in values && values[column] !== before[column]
      const switchedOn = (column: string) => values[column] === 1 && before[column] !== 1
      // The exclusions are also kept in a table of their own, which the column mirrors.
      if (RESCAN_ON_CHANGE.some(changed) || WORK_WHEN_SWITCHED_ON.some(switchedOn)) {
        await queueScan(req.params.libraryId)
      }
      return reply.code(204).send()
    },
  })

  app.delete<{ Params: { libraryId: string } }>(
    '/api/v1/libraries/:libraryId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('libraries')
        .select('id')
        .where('id', '=', req.params.libraryId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Library not found' })
      await db.deleteFrom('libraries').where('id', '=', req.params.libraryId).execute()
      announceLibrary(opts.events, 'LibraryDeleted', req.params.libraryId)
      return reply.code(204).send()
    },
  )

  /** Queue an administrative operation on a library. */
  const action = (
    path: string,
    type: string,
    priority: number,
    payload: (libraryId: string, query: Record<string, unknown>) => unknown = () => ({}),
  ) => {
    app.post<{ Params: { libraryId: string } }>(path, { preHandler: requireAdmin }, async (req, reply) => {
      const existing = await db
        .selectFrom('libraries')
        .select('id')
        .where('id', '=', req.params.libraryId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Library not found' })

      await enqueueJob(db, {
        type,
        uniqueKey: `${type.toUpperCase()}_${req.params.libraryId}`,
        priority,
        payload: payload(req.params.libraryId, (req.query ?? {}) as Record<string, unknown>),
      })
      return reply.code(202).send()
    })
  }

  // `deep` is a query parameter in the contract. It was read from the body, which
  // no client sends, so a deep scan never happened.
  action('/api/v1/libraries/:libraryId/scan', 'ScanLibrary', JOB_PRIORITY.HIGHEST, (libraryId, query) => ({
    libraryId,
    scanDeep: booleanParam(query.deep) === true,
  }))
  action('/api/v1/libraries/:libraryId/analyze', 'AnalyzeLibrary', JOB_PRIORITY.DEFAULT, (libraryId) => ({ libraryId }))
  action('/api/v1/libraries/:libraryId/empty-trash', 'EmptyTrash', JOB_PRIORITY.LOW, (libraryId) => ({ libraryId }))
  action(
    '/api/v1/libraries/:libraryId/metadata/refresh',
    'RefreshLibraryMetadata',
    JOB_PRIORITY.DEFAULT,
    (libraryId) => ({ libraryId }),
  )
}

export type { LibraryDto }
