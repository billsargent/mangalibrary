/**
 * Komga's dates, as this server keeps dates.
 *
 * Komga stores every date and time - when a file was last changed, when a book was
 * read, when a row was made - as a local time of the machine it ran on, with no
 * zone: `2026-05-25 18:22:10.603` is 16:22 UTC in Central Europe in summer and
 * 17:22 in winter. This server keeps UTC. Read as UTC, every file time is off by
 * the zone's offset, and the first scan takes every book for a changed one.
 */

/** The machine's own zone, which is Komga's unless it ran elsewhere or in a container set to UTC. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Whether a zone name is one the runtime knows. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()
/** Offsets already worked out, by zone and hour: a zone's offset does not change within an hour. */
const offsets = new Map<string, number>()

/** How far ahead of UTC a zone is at an instant, in milliseconds. */
function offsetAt(zone: string, instant: number): number {
  const hour = Math.floor(instant / 3_600_000)
  const key = `${zone}\u0000${hour}`
  const known = offsets.get(key)
  if (known !== undefined) return known

  let format = formats.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formats.set(zone, format)
  }
  const parts = Object.fromEntries(
    format.formatToParts(new Date(hour * 3_600_000)).map((part) => [part.type, part.value]),
  )
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  const offset = local - hour * 3_600_000
  offsets.set(key, offset)
  return offset
}

/**
 * The instant a wall-clock time in a zone names, as milliseconds since the epoch.
 *
 * The offset is looked up twice - at the guess, then at the answer - so that a time
 * near a change to or from summer time lands on the right side of it.
 */
export function zonedToEpoch(wallClockAsUtc: number, zone: string): number {
  if (zone === 'UTC' || zone === 'Etc/UTC') return wallClockAsUtc
  const first = wallClockAsUtc - offsetAt(zone, wallClockAsUtc)
  return wallClockAsUtc - offsetAt(zone, first)
}
