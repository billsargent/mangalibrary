import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { canAccessLibrary } from '../auth/access.js'
import { requireAdmin, requireAuth } from '../auth/session.js'
import { announceLibrary } from '../content-events.js'
import type { DB } from '../db/schema.js'
import type { EventBus } from '../events.js'
import type { FetchJson } from '../http.js'
import { JOB_PRIORITY, enqueueJob } from '../jobs.js'
import { nextTsid } from '../tsid.js'
import { toLibraryDto, type LibraryDto, type LibraryRow } from './dto.js'

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

function currentUser(req: FastifyRequest) {
  const user = req.user
  if (!user) throw new Error('unauthenticated')
  return user
}

export async function registerLibraryRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const { db } = opts

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

  app.patch<{ Params: { libraryId: string } }>(
    '/api/v1/libraries/:libraryId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = await db
        .selectFrom('libraries')
        .select('id')
        .where('id', '=', req.params.libraryId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Library not found' })

      const body = (req.body ?? {}) as Record<string, unknown>
      const values: Record<string, unknown> = { last_modified_date: new Date().toISOString() }
      scalarFields(body, values)
      await db
        .updateTable('libraries')
        .set(values as never)
        .where('id', '=', req.params.libraryId)
        .execute()
      await replaceExclusions(db, req.params.libraryId, body.scanDirectoryExclusions)
      announceLibrary(opts.events, 'LibraryChanged', req.params.libraryId)
      return reply.code(204).send()
    },
  )

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
    payload: (libraryId: string, body: Record<string, unknown>) => unknown = () => ({}),
  ) => {
    app.post<{ Params: { libraryId: string } }>(path, { preHandler: requireAdmin }, async (req, reply) => {
      const existing = await db
        .selectFrom('libraries')
        .select('id')
        .where('id', '=', req.params.libraryId)
        .executeTakeFirst()
      if (!existing) return reply.code(404).send({ message: 'Library not found' })

      const body = (req.body ?? {}) as Record<string, unknown>
      await enqueueJob(db, {
        type,
        uniqueKey: `${type.toUpperCase()}_${req.params.libraryId}`,
        priority,
        payload: payload(req.params.libraryId, body),
      })
      return reply.code(202).send()
    })
  }

  action('/api/v1/libraries/:libraryId/scan', 'ScanLibrary', JOB_PRIORITY.HIGH, (libraryId, body) => ({
    libraryId,
    scanDeep: body.deep === true,
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
