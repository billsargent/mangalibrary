/** Reads a JSON document from a URL. Injected so tests never touch the network. */
export type FetchJson = (url: string) => Promise<unknown>

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Read a JSON document from the outside world.
 *
 * The endpoints that use this show information that lives somewhere else - a
 * feed, a release list. They must not be able to hang a request or a test run, so
 * the request has a deadline, and a failure is reported by the caller as "nothing
 * to show" rather than propagated as an error.
 */
export async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}
