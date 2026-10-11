import type { FastifyInstance } from 'fastify'
import { isAdmin } from '../auth/access.js'
import { requireAuth } from '../auth/session.js'
import type { AuthUser } from '../auth/types.js'
import type { SseEvent } from '../events.js'
import { requireUser } from './context.js'
import type { RouteOptions } from './libraries.js'

/** Idle connections are kept alive with a comment, as the reference does. */
const HEARTBEAT_MS = 15_000

/** How often the queue depth is pushed to administrators. */
const TASK_STATUS_MS = 10_000

interface Client {
  user: AuthUser
  write(chunk: string): void
}

function encode(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Count queued jobs by type, the shape the queue status event carries. */
async function taskCounts(opts: RouteOptions): Promise<{ count: number; countByType: Record<string, number> }> {
  const rows = await opts.db
    .selectFrom('jobs')
    .select(({ fn }) => ['type', fn.countAll<number>().as('count')])
    .groupBy('type')
    .execute()

  const countByType: Record<string, number> = {}
  let count = 0
  for (const row of rows) {
    countByType[row.type] = row.count
    count += row.count
  }
  return { count, countByType }
}

/**
 * Server-sent events: one long-lived response per open browser tab, carrying the
 * changes that page is watching for.
 *
 * A client is told about something only when it is allowed to know: either it is
 * an administrator and the event is administrative, or it is the user the event
 * is about. That filtering happens per connection, so a route publishes once and
 * each listener decides whether it cares.
 */
export async function registerSseRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  const clients = new Set<Client>()
  let heartbeat: NodeJS.Timeout | undefined
  let taskStatus: NodeJS.Timeout | undefined

  // Timers run only while somebody is listening: a server with no open stream
  // does no background work, and tests that never open one are not kept alive.
  const startTimers = (): void => {
    heartbeat ??= setInterval(() => {
      for (const client of clients) client.write(': heartbeat\n\n')
    }, HEARTBEAT_MS)

    taskStatus ??= setInterval(() => {
      void taskCounts(opts)
        .then((payload) => {
          for (const client of clients) {
            if (isAdmin(client.user)) client.write(encode('TaskQueueStatus', payload))
          }
        })
        .catch(() => {
          // The queue is unreadable at shutdown; the next tick will retry.
        })
    }, TASK_STATUS_MS)
  }

  const stopTimers = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    if (taskStatus) clearInterval(taskStatus)
    heartbeat = undefined
    taskStatus = undefined
  }

  app.addHook('onClose', async () => stopTimers())

  // Domain events published by the routes.
  opts.events.subscribe((event: SseEvent) => {
    for (const client of clients) {
      if (event.adminOnly && !isAdmin(client.user)) continue
      if (event.userId !== undefined && event.userId !== client.user.id) continue
      client.write(encode(event.name, event.data))
    }
  })

  app.get('/sse/v1/events', { preHandler: requireAuth }, (req, reply) => {
    const user = requireUser(req)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // The response is written by hand from here on.
    reply.hijack()

    const client: Client = {
      user,
      write: (chunk) => {
        try {
          reply.raw.write(chunk)
        } catch {
          // The connection is going away; its close handler removes the client.
        }
      },
    }

    clients.add(client)
    startTimers()
    client.write(': connected\n\n')

    // An admin opening the stream wants to know the queue depth now, not at the
    // next tick ten seconds away.
    if (isAdmin(user)) {
      void taskCounts(opts)
        .then((payload) => client.write(encode('TaskQueueStatus', payload)))
        .catch(() => {
          // Reported by the next tick.
        })
    }

    const close = (): void => {
      clients.delete(client)
      if (clients.size === 0) stopTimers()
    }

    req.raw.on('close', close)
    reply.raw.on('close', close)
    // The stream ends when the client disconnects, never on its own.
    return reply
  })
}
