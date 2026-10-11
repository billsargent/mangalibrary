import { release } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../auth/session.js'
import { APP_VERSION } from '../version.js'
import { requireUser } from './context.js'
import type { RouteOptions } from './libraries.js'

/** How long a fetched document is reused before the source is asked again. */
const CACHE_TTL_MS = 60 * 60 * 1000

interface FeedItem {
  id: string
  [key: string]: unknown
}

interface Feed {
  version: string
  title: string
  [key: string]: unknown
  items: FeedItem[]
}

/** A release as the source publishes it, in the shape the reference reads. */
interface SourceRelease {
  tag_name?: unknown
  published_at?: unknown
  html_url?: unknown
  prerelease?: unknown
  body?: unknown
}

function isFeedItem(value: unknown): value is FeedItem {
  const id = (value as { id?: unknown } | null)?.id
  return typeof value === 'object' && value !== null && typeof id === 'string' && id !== ''
}

/**
 * Whether a document is a JSON feed.
 *
 * A URL that is configured but answers something else is a configuration mistake,
 * and reporting it as "nothing to show" is better than passing a foreign document
 * through to a client that expects a feed.
 */
function isFeed(value: unknown): value is { version: string; title: string; items: unknown[] } {
  const feed = value as { version?: unknown; title?: unknown; items?: unknown } | null
  return (
    typeof feed === 'object' &&
    feed !== null &&
    typeof feed.version === 'string' &&
    feed.version !== '' &&
    typeof feed.title === 'string' &&
    Array.isArray(feed.items)
  )
}

/**
 * Keep a fetched document for an hour.
 *
 * These endpoints show something hosted elsewhere, and a browser that opens the
 * announcements panel repeatedly must not turn into repeated outbound requests.
 * The cache lives with the app, so one server instance has one copy.
 */
function cacheFor<T>(ttlMs = CACHE_TTL_MS) {
  let entry: { key: string; at: number; value: T } | undefined

  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      if (entry && entry.key === key && Date.now() - entry.at < ttlMs) return entry.value

      const value = await load()
      entry = { key, at: Date.now(), value }
      return value
    },
  }
}

/**
 * What the server knows that is not about the library: its own version, the
 * announcements it has been pointed at, and the release notes it has been pointed
 * at.
 *
 * The last two read from a URL rather than a bundled copy, because a server
 * cannot know where a fork's announcements or releases live. With nothing
 * configured they answer "nothing to show" rather than inventing content, and the
 * fetch is injected, so this is exercised without touching the network.
 */
export async function registerSystemRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const feeds = cacheFor<Feed>()
  const releaseNotes = cacheFor<SourceRelease[]>()

  app.get('/actuator/info', async () => ({
    build: {
      artifact: 'mangalibrary',
      group: 'mangalibrary',
      name: 'mangalibrary',
      version: APP_VERSION,
    },
    runtime: {
      name: 'Node.js',
      version: process.version,
    },
    os: {
      name: process.platform,
      arch: process.arch,
      version: release(),
    },
  }))

  /** Read the announcements feed, or report that there is none to read. */
  const loadFeed = async (): Promise<Feed | undefined> => {
    const url = opts.announcementsUrl
    if (url === null) return undefined

    try {
      return await feeds.get(url, async () => {
        const body = await opts.fetchJson(url)
        if (!isFeed(body)) throw new Error('the configured announcements URL did not answer with a feed')
        return { ...body, items: body.items.filter(isFeedItem) } as Feed
      })
    } catch {
      return undefined
    }
  }

  const loadReleases = async (): Promise<SourceRelease[] | undefined> => {
    const url = opts.releasesUrl
    if (url === null) return undefined

    try {
      return await releaseNotes.get(url, async () => {
        const body = await opts.fetchJson(url)
        return Array.isArray(body) ? (body as SourceRelease[]) : []
      })
    } catch {
      return undefined
    }
  }

  app.get('/api/v1/announcements', { preHandler: requireAdmin }, async (req, reply) => {
    const feed = await loadFeed()
    if (feed === undefined) return reply.code(404).send({ message: 'No announcements are available' })

    const read = await opts.db
      .selectFrom('announcements_read')
      .select('announcement_id')
      .where('user_id', '=', requireUser(req).id)
      .execute()
    const readIds = new Set(read.map((row) => row.announcement_id))

    // The feed is passed through as it came, with the read flag added per item:
    // that flag is the only thing this server knows that the feed does not.
    return {
      ...feed,
      items: feed.items.map((item) => ({ ...item, _komga: { read: readIds.has(item.id) } })),
    }
  })

  app.put('/api/v1/announcements', { preHandler: requireAdmin }, async (req, reply) => {
    const user = requireUser(req)
    const ids = Array.isArray(req.body) ? req.body.filter((id): id is string => typeof id === 'string') : []
    const now = new Date().toISOString()

    await opts.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('announcements_read').where('user_id', '=', user.id).execute()
      if (ids.length > 0) {
        await trx
          .insertInto('announcements_read')
          .values(ids.map((announcementId) => ({ user_id: user.id, announcement_id: announcementId, read_date: now })))
          .execute()
      }
    })

    return reply.code(204).send()
  })

  app.get('/api/v1/releases', { preHandler: requireAdmin }, async (_req, reply) => {
    const source = await loadReleases()
    if (source === undefined) return reply.code(404).send({ message: 'No releases are available' })

    return source.map((entry, index) => ({
      version: typeof entry.tag_name === 'string' ? entry.tag_name : '',
      releaseDate: typeof entry.published_at === 'string' ? entry.published_at : '',
      url: typeof entry.html_url === 'string' ? entry.html_url : '',
      // The source lists newest first, which is what makes the first entry the
      // one a client should offer to install.
      latest: index === 0,
      preRelease: entry.prerelease === true,
      description: typeof entry.body === 'string' ? entry.body : '',
    }))
  })
}
