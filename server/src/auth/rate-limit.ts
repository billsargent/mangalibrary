/**
 * A small in-memory limiter, for the one endpoint a stranger can reach without
 * credentials beyond the claim.
 *
 * The reference has no rate limiting anywhere, so this is an addition: registration
 * is open to the world when an admin turns it on, and an endpoint that creates an
 * account has to be cheaper to refuse than to abuse. The count lives in this process
 * and is not shared with another one, which is enough for a single-server deployment
 * and is documented as such.
 */

/** What a limiter needs to know about time, so a test can move it on. */
export interface Clock {
  now(): number
}

export interface RateLimitOptions {
  /** How many attempts are allowed within the window. */
  limit: number
  /** How long the window is, in milliseconds. */
  windowMs: number
  now?: () => number
}

/**
 * Attempts counted per key - an address, an email - over a sliding window.
 *
 * A window rather than a token bucket: the point is to make repeated attempts wait,
 * and a plain count of what happened recently is the easiest thing to reason about
 * when somebody asks why they were refused. The count is per key because the two
 * keys mean different things: an address trying many times is one network, and an
 * address being tried many times is one account being probed.
 */
export class RateLimiter {
  private readonly attempts = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: RateLimitOptions) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.now = options.now ?? Date.now
  }

  /** Whether the limit has been reached, without counting anything. */
  reached(key: string): boolean {
    const now = this.now()
    return (this.attempts.get(key) ?? []).filter((at) => now - at < this.windowMs).length >= this.limit
  }

  /** Count an attempt, whether or not the limit allows more. */
  record(key: string): void {
    const now = this.now()
    const recent = (this.attempts.get(key) ?? []).filter((at) => now - at < this.windowMs)
    recent.push(now)
    this.attempts.set(key, recent)
    // A key nobody has used for a window is forgotten, so the map does not grow for ever.
    if (this.attempts.size > 10_000) {
      for (const [other, times] of this.attempts) {
        if (times.every((at) => now - at >= this.windowMs)) this.attempts.delete(other)
      }
    }
  }

  /** Whether an attempt may be made, counting it when it may. */
  allow(key: string): boolean {
    const now = this.now()
    const recent = (this.attempts.get(key) ?? []).filter((at) => now - at < this.windowMs)

    if (recent.length >= this.limit) {
      this.attempts.set(key, recent)
      return false
    }

    recent.push(now)
    this.attempts.set(key, recent)
    return true
  }
}
