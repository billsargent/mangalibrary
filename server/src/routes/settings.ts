import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { invalidateRememberMeKey, requireAdmin, requireAuth } from '../auth/session.js'
import { isAdmin } from '../auth/access.js'
import type { DB } from '../db/schema.js'
import {
  DEFAULT_REMEMBER_ME_DURATION_DAYS,
  SETTING_KEYS,
  deleteSetting,
  getBooleanSetting,
  getIntSetting,
  getSetting,
  setSetting,
} from '../settings.js'
import { MAX_UPLOAD_BYTES } from '../uploads.js'
import { requireUser } from './context.js'
import type { RouteOptions } from './libraries.js'

/** Thumbnail widths the reference implementation defines. */
const THUMBNAIL_SIZES = ['DEFAULT', 'MEDIUM', 'LARGE', 'XLARGE'] as const

const DEFAULT_TASK_POOL_SIZE = 1

/**
 * A setting that may come from the configuration or from the database, with the
 * value actually in use. Reported so an admin UI can show where a value comes
 * from, and grey out what it cannot change.
 */
interface MultiSource<T> {
  configurationSource: T | null
  databaseSource: T | null
  effectiveValue: T | null
}

interface SettingsDto {
  deleteEmptyCollections: boolean
  deleteEmptyReadLists: boolean
  rememberMeDurationDays: number
  thumbnailSize: string
  taskPoolSize: number
  serverPort: MultiSource<number>
  serverContextPath: MultiSource<string>
  koboProxy: boolean
  /**
   * A plain number, unlike the ports above: the contract reports the Kobo proxy port as an
   * integer and only `serverPort` as a value with sources. Sending an object where a number
   * is documented is not something a client can read - an admin UI binds it to a number
   * field and gets `NaN` - so the stored value is what is reported.
   */
  koboPort: number | null
  kepubifyPath: MultiSource<string>
  maxUploadFileSizeBytes: number
}

function multiSource<T>(configuration: T | null, database: T | null, effective: T | null): MultiSource<T> {
  return { configurationSource: configuration, databaseSource: database, effectiveValue: effective }
}

/** A stored integer, or null when unset or unparseable. */
function optionalInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}
async function buildSettings(db: Kysely<DB>, opts: RouteOptions): Promise<SettingsDto> {
  const [deleteEmptyCollections, deleteEmptyReadLists, rememberMeDurationDays, taskPoolSize, koboProxy] =
    await Promise.all([
      getBooleanSetting(db, SETTING_KEYS.deleteEmptyCollections, false),
      getBooleanSetting(db, SETTING_KEYS.deleteEmptyReadLists, false),
      getIntSetting(db, SETTING_KEYS.rememberMeDurationDays, DEFAULT_REMEMBER_ME_DURATION_DAYS),
      getIntSetting(db, SETTING_KEYS.taskPoolSize, DEFAULT_TASK_POOL_SIZE),
      getBooleanSetting(db, SETTING_KEYS.koboProxy, false),
    ])

  const [thumbnailSize, storedPort, storedKoboPort, kepubifyPath] = await Promise.all([
    getSetting(db, SETTING_KEYS.thumbnailSize),
    getSetting(db, SETTING_KEYS.serverPort),
    getSetting(db, SETTING_KEYS.koboPort),
    getSetting(db, SETTING_KEYS.kepubifyPath),
  ])

  const databasePort = optionalInt(storedPort)
  const databaseKoboPort = optionalInt(storedKoboPort)
  const configuredPort = opts.configuredPort ?? null

  return {
    deleteEmptyCollections,
    deleteEmptyReadLists,
    rememberMeDurationDays,
    thumbnailSize: thumbnailSize ?? 'DEFAULT',
    taskPoolSize,
    // The port in use is the one the process was started with.
    serverPort: multiSource<number>(configuredPort, databasePort, opts.port ?? null),
    // A context path is not supported: the server always answers at the root.
    serverContextPath: multiSource<string>(null, null, null),
    koboProxy,
    koboPort: databaseKoboPort,
    kepubifyPath: multiSource(null, kepubifyPath ?? null, kepubifyPath ?? null),
    maxUploadFileSizeBytes: MAX_UPLOAD_BYTES,
  }
}

interface Failure {
  message: string
}

/** Validate the parts of a settings update that are more than a type check. */
function validate(body: Record<string, unknown>): Failure | undefined {
  const thumbnailSize = body.thumbnailSize
  if (thumbnailSize !== undefined && !(THUMBNAIL_SIZES as readonly unknown[]).includes(thumbnailSize)) {
    return { message: `thumbnailSize must be one of ${THUMBNAIL_SIZES.join(', ')}` }
  }

  for (const [field, minimum] of [
    ['rememberMeDurationDays', 1],
    ['taskPoolSize', 1],
  ] as const) {
    const value = body[field]
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || (value as number) < minimum) {
      return { message: `${field} must be an integer of at least ${minimum}` }
    }
  }

  for (const field of ['serverPort', 'koboPort'] as const) {
    const value = body[field]
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
      return { message: `${field} must be a port number, or null to clear it` }
    }
  }

  // Accepting a context path we cannot serve would leave clients calling paths
  // that do not exist, so it is refused rather than stored and ignored.
  const contextPath = body.serverContextPath
  if (contextPath !== undefined && contextPath !== null && contextPath !== '') {
    return { message: 'serverContextPath is not supported by this server' }
  }

  return undefined
}

async function applyUpdate(db: Kysely<DB>, body: Record<string, unknown>): Promise<void> {
  if (typeof body.deleteEmptyCollections === 'boolean') {
    await setSetting(db, SETTING_KEYS.deleteEmptyCollections, String(body.deleteEmptyCollections))
  }
  if (typeof body.deleteEmptyReadLists === 'boolean') {
    await setSetting(db, SETTING_KEYS.deleteEmptyReadLists, String(body.deleteEmptyReadLists))
  }
  if (typeof body.rememberMeDurationDays === 'number') {
    await setSetting(db, SETTING_KEYS.rememberMeDurationDays, String(body.rememberMeDurationDays))
  }
  if (typeof body.thumbnailSize === 'string') {
    await setSetting(db, SETTING_KEYS.thumbnailSize, body.thumbnailSize)
  }
  if (typeof body.taskPoolSize === 'number') {
    await setSetting(db, SETTING_KEYS.taskPoolSize, String(body.taskPoolSize))
  }
  if (typeof body.koboProxy === 'boolean') {
    await setSetting(db, SETTING_KEYS.koboProxy, String(body.koboProxy))
  }
  if (body.renewRememberMeKey === true) {
    await setSetting(db, 'REMEMBER_ME_KEY', randomBytes(32).toString('hex'))
    invalidateRememberMeKey()
  }

  // Nullable settings: absent leaves the value alone, null clears it.
  for (const [field, key] of [
    ['serverPort', SETTING_KEYS.serverPort],
    ['koboPort', SETTING_KEYS.koboPort],
    ['kepubifyPath', SETTING_KEYS.kepubifyPath],
  ] as const) {
    if (!(field in body)) continue
    const value = body[field]
    if (value === null || value === '') await deleteSetting(db, key)
    else if (typeof value === 'number' || typeof value === 'string') await setSetting(db, key, String(value))
  }
}

/** Client settings are arbitrary namespaced keys, stored as strings. */
const CLIENT_KEY = /^[a-z](?:[a-z0-9_-]*[a-z0-9])*(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])*)*$/

interface ClientSetting {
  allowUnauthorized: boolean
  value: string
}

function invalidClientKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value).filter((key) => !CLIENT_KEY.test(key))
}

async function readGlobal(db: Kysely<DB>, anonymousOnly: boolean): Promise<Record<string, ClientSetting>> {
  const query = db.selectFrom('client_settings_global').select(['key', 'value', 'allow_unauthorized'])
  const rows = await (anonymousOnly ? query.where('allow_unauthorized', '=', 1) : query).execute()

  const settings: Record<string, ClientSetting> = {}
  for (const row of rows) {
    settings[row.key] = { allowUnauthorized: row.allow_unauthorized === 1, value: row.value }
  }
  return settings
}

async function readUser(db: Kysely<DB>, userId: string): Promise<Record<string, ClientSetting>> {
  const rows = await db
    .selectFrom('client_settings_user')
    .select(['key', 'value'])
    .where('user_id', '=', userId)
    .execute()

  const settings: Record<string, ClientSetting> = {}
  for (const row of rows) settings[row.key] = { allowUnauthorized: false, value: row.value }
  return settings
}

/** Server settings and the client-side key/value store the UI keeps here. */
export async function registerSettingsRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const db = opts.db

  app.get('/api/v1/settings', { preHandler: requireAuth }, async (req) => {
    const settings = await buildSettings(db, opts)
    // Only the upload limit is useful to a reader; the rest describes the host.
    if (isAdmin(req.user!)) return settings
    return { maxUploadFileSizeBytes: settings.maxUploadFileSizeBytes }
  })

  app.patch('/api/v1/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const failure = validate(body)
    if (failure) return reply.code(400).send(failure)

    await applyUpdate(db, body)
    return reply.code(204).send()
  })

  app.get('/api/v1/client-settings/global/list', async (req) => readGlobal(db, !req.user))

  app.patch('/api/v1/client-settings/global', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const invalid = invalidClientKeys(body)
    if (invalid.length > 0) return reply.code(400).send({ message: `invalid setting keys: ${invalid.join(', ')}` })

    for (const [key, value] of Object.entries(body)) {
      const setting = (value ?? {}) as { allowUnauthorized?: unknown; value?: unknown }
      const stored = typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value ?? null)
      const allowUnauthorized = setting.allowUnauthorized === true ? 1 : 0

      await db
        .insertInto('client_settings_global')
        .values({ key, value: stored, allow_unauthorized: allowUnauthorized })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: stored, allow_unauthorized: allowUnauthorized }))
        .execute()
    }

    return reply.code(204).send()
  })

  app.delete('/api/v1/client-settings/global', { preHandler: requireAdmin }, async (req, reply) => {
    const keys = Array.isArray(req.body) ? req.body.map(String) : []
    if (keys.length > 0) {
      await db.deleteFrom('client_settings_global').where('key', 'in', keys).execute()
    }
    return reply.code(204).send()
  })

  app.get('/api/v1/client-settings/user/list', { preHandler: requireAuth }, async (req) =>
    readUser(db, requireUser(req).id),
  )

  app.patch('/api/v1/client-settings/user', { preHandler: requireAuth }, async (req, reply) => {
    const user = requireUser(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const invalid = invalidClientKeys(body)
    if (invalid.length > 0) return reply.code(400).send({ message: `invalid setting keys: ${invalid.join(', ')}` })

    for (const [key, value] of Object.entries(body)) {
      const setting = (value ?? {}) as { value?: unknown }
      await db
        .insertInto('client_settings_user')
        .values({ user_id: user.id, key, value: String(setting.value ?? '') })
        .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({ value: String(setting.value ?? '') }))
        .execute()
    }

    return reply.code(204).send()
  })

  app.delete('/api/v1/client-settings/user', { preHandler: requireAuth }, async (req, reply) => {
    const user = requireUser(req)
    const keys = Array.isArray(req.body) ? req.body.map(String) : []
    if (keys.length > 0) {
      await db.deleteFrom('client_settings_user').where('user_id', '=', user.id).where('key', 'in', keys).execute()
    }
    return reply.code(204).send()
  })
}
