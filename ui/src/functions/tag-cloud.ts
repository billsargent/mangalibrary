/** One tag of the cloud, as the server lists it. */
export interface CloudTag {
  tag: string
  /** The letter it is listed under: lower case, without accents, `#` for anything not a letter. */
  letter: string
  /** How many series it leads to. */
  count: number
}

/** The type sizes a tag can be shown at, smallest first, in rem. */
export const TAG_SIZES = [0.875, 1.125, 1.375, 1.625, 2] as const

/**
 * Which of the sizes a tag is shown at, by how many series carry it against the
 * most any tag has.
 *
 * On a log scale: counts in a library run from one to thousands, and on a straight
 * scale one large tag would leave every other at the smallest size.
 */
export function tagSize(count: number, largest: number): number {
  if (largest <= 1 || count <= 1) return 0
  const share = Math.log(count) / Math.log(largest)
  return Math.min(TAG_SIZES.length - 1, Math.round(share * (TAG_SIZES.length - 1)))
}

/** The letters there are tags under, in order, `#` first, with how many tags each has. */
export function cloudLetters(tags: readonly CloudTag[]): {
  letters: string[]
  counts: Record<string, number>
} {
  const counts: Record<string, number> = {}
  for (const entry of tags) counts[entry.letter] = (counts[entry.letter] ?? 0) + 1
  const letters = Object.keys(counts).sort((left, right) => {
    if (left === '#') return -1
    if (right === '#') return 1
    return left.localeCompare(right)
  })
  return { letters, counts }
}
