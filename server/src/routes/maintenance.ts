import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../auth/session.js'
import { requireUser } from './context.js'
import { springPage } from './dto.js'
import type { RouteOptions } from './libraries.js'
import { applySort, paging, parseSort, toArray } from './query.js'

/** Sortable properties of a historical event, as the contract names them. */
const HISTORY_SORT: Record<string, string> = { id: 'id', timestamp: 'timestamp', type: 'type' }

interface PathEntry {
  type: 'directory' | 'file'
  name: string
  path: string
}

/**
 * Names the operating system hides from a plain listing.
 *
 * On Windows a file can also carry the hidden attribute, which Node does not
 * expose, so a dot-prefixed name is the only case we can recognise there.
 */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** The drives of a Windows host, or the single root of a POSIX one. */
function rootDirectories(): PathEntry[] {
  if (process.platform !== 'win32') return [{ type: 'directory', name: '/', path: '/' }]

  const roots: PathEntry[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const path = `${String.fromCharCode(code)}:\\`
    if (existsSync(path)) roots.push({ type: 'directory', name: path, path })
  }
  return roots
}

async function listDirectory(path: string, showFiles: boolean): Promise<PathEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const listed: PathEntry[] = []
  for (const entry of entries) {
    if (isHidden(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) listed.push({ type: 'directory', name: entry.name, path: child })
    else if (showFiles && entry.isFile()) listed.push({ type: 'file', name: entry.name, path: child })
  }

  return listed.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
}

/**
 * Bookkeeping an operator needs and nothing a reader does: what the server did
 * to the files (history), what it is still about to do (the task queue), the
 * sync state it keeps for a device, and a way to look at the host's directories
 * when pointing a library at one.
 */
export async function registerMaintenanceRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const db = opts.db

  app.get('/api/v1/history', { preHandler: requireAdmin }, async (req) => {
    const { page, size } = paging(req.query)
    const sorts = parseSort((req.query as { sort?: unknown }).sort, HISTORY_SORT, [
      { column: 'timestamp', direction: 'desc' },
    ] as const)
    // Paging needs a total order; the id breaks ties between events recorded in
    // the same millisecond, which a scan easily produces.
    const ordered = sorts.some((spec) => spec.column === 'id')
      ? sorts
      : [...sorts, { column: 'id', direction: 'asc' as const }]

    const total = await db
      .selectFrom('historical_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()

    const rows = await applySort(db.selectFrom('historical_events').selectAll(), ordered)
      .limit(size)
      .offset(page * size)
      .execute()

    const content = rows.map((row) => {
      const event: Record<string, unknown> = {
        id: row.id,
        type: row.type,
        timestamp: row.timestamp,
        properties: JSON.parse(row.properties || '{}') as unknown,
      }
      if (row.book_id !== null) event.bookId = row.book_id
      if (row.series_id !== null) event.seriesId = row.series_id
      return event
    })

    return springPage(content, page, size, total.count)
  })

  app.delete('/api/v1/tasks', { preHandler: requireAdmin }, async () => {
    // Queued work has no owner: everything in the queue is fair game.
    const result = await db.deleteFrom('jobs').where('owner', 'is', null).executeTakeFirst()
    return Number(result.numDeletedRows)
  })

  app.delete('/api/v1/syncpoints/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = requireUser(req)
    const keyIds = toArray((req.query as { key_id?: unknown }).key_id)

    await db.transaction().execute(async (trx) => {
      let query = trx.selectFrom('sync_points').select('id').where('user_id', '=', user.id)
      if (keyIds.length > 0) query = query.where('api_key_id', 'in', keyIds)
      const ids = (await query.execute()).map((row) => row.id)
      if (ids.length === 0) return

      await trx.deleteFrom('sync_point_book').where('sync_point_id', 'in', ids).execute()
      await trx.deleteFrom('sync_point_readlist').where('sync_point_id', 'in', ids).execute()
      await trx.deleteFrom('sync_points').where('id', 'in', ids).execute()
    })

    return reply.code(204).send()
  })

  /**
   * List the host's directories so an admin can point a library at one.
   *
   * This is a deliberate window into the filesystem of the machine the server
   * runs on, which is what the reference implementation offers and what the
   * library settings screen needs. It is admin-only.
   */
  app.post('/api/v1/filesystem', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown; showFiles?: unknown }
    const path = typeof body.path === 'string' ? body.path : ''
    const showFiles = body.showFiles === true

    if (path === '') return { directories: rootDirectories(), files: [] }
    if (!isAbsolute(path)) return reply.code(400).send({ message: 'Path must be absolute' })

    let target = path
    try {
      const info = await stat(path)
      if (!info.isDirectory()) target = dirname(path)
    } catch {
      return reply.code(400).send({ message: 'Path does not exist' })
    }

    try {
      const listed = await listDirectory(target, showFiles)
      return {
        parent: dirname(target),
        directories: listed.filter((entry) => entry.type === 'directory'),
        files: listed.filter((entry) => entry.type === 'file'),
      }
    } catch {
      return reply.code(400).send({ message: 'Path does not exist' })
    }
  })
}
