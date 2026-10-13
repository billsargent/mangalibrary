/** One thing in a collection or a read list, as the contents editor lists it. */
export type ContentsItem = {
  id: string
  title: string
  subtitle?: string
}

/**
 * The rows to show for a list of ids, in the order of the ids.
 *
 * An id nothing is known about still gets a row, named by its id: it is in the
 * list whether or not its name could be fetched, and has to be removable.
 */
export function contentsRows(
  ids: readonly string[],
  known: ReadonlyMap<string, Omit<ContentsItem, 'id'>>,
): ContentsItem[] {
  return ids.map((id) => ({ id, title: id, ...known.get(id) }))
}

/** The ids with one more at the end, unless it is there already. */
export function withAdded(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id]
}

/** The ids without one of them. */
export function withRemoved(ids: readonly string[], id: string): string[] {
  return ids.filter((it) => it !== id)
}
