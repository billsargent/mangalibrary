import type { FastifyRequest } from 'fastify'

/**
 * Cache directives for content that only changes when a book is analysed again.
 *
 * The reference answers page and resource requests with a private, immediately
 * stale directive and a `Last-Modified`, so a client revalidates instead of
 * caching blindly.
 */
export const CACHE_PRIVATE = 'max-age=0, private, must-revalidate'

export function cacheHeaders(lastModified: Date): Record<string, string> {
  return { 'cache-control': CACHE_PRIVATE, 'last-modified': lastModified.toUTCString() }
}

/**
 * Whether a client's `If-Modified-Since` says it already has this version.
 *
 * HTTP dates carry second precision, so the stored time is truncated the same way
 * before comparing; otherwise a value that was rounded down on the way out could
 * never match on the way back in.
 */
export function isNotModified(req: FastifyRequest, lastModified: Date): boolean {
  const since = req.headers['if-modified-since']
  if (typeof since !== 'string') return false
  const parsed = Date.parse(since)
  if (Number.isNaN(parsed)) return false
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= parsed
}
