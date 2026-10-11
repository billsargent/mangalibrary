/**
 * Language tags, as metadata documents write them.
 *
 * The reference validates a tag against ICU's list of ISO languages before it
 * stores it. That list is not something this server carries, so what is checked
 * here is the shape of a BCP47 tag - a language, then optional script, region and
 * variants - and the casing is normalised the way the standard wants it. An
 * invented language therefore gets through, which is the deliberate difference
 * recorded in `docs/COMPATIBILITY.md`.
 */

/** The casing BCP47 asks for: `en`, `en-US`, `zh-Hans`, `sl-rozaj-biske`. */
function normalisedSubtag(subtag: string): string | null {
  // A region, spelled `US` or as a number, and a script, spelled `Hans`.
  if (/^[A-Za-z]{2}$/.test(subtag)) return subtag.toUpperCase()
  if (/^\d{3}$/.test(subtag)) return subtag
  if (/^[A-Za-z]{4}$/.test(subtag)) return subtag[0]!.toUpperCase() + subtag.slice(1).toLowerCase()
  // A variant or an extension.
  if (/^[A-Za-z0-9]{5,8}$/.test(subtag)) return subtag.toLowerCase()
  return null
}

/**
 * The tag a value is, normalised, or null when it is not one.
 *
 * A tag has to start with a language: two or three letters. `Unknown`, which some
 * documents write, is not one, and neither is an empty element.
 */
export function normalisedLanguage(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null

  const parts = value
    .trim()
    .replace(/_/g, '-')
    .split('-')
    .filter((part) => part !== '')
  const primary = parts[0]
  if (primary === undefined || !/^[A-Za-z]{2,3}$/.test(primary)) return null

  const normalised = [primary.toLowerCase()]
  for (const part of parts.slice(1)) {
    const subtag = normalisedSubtag(part)
    if (subtag === null) return null
    normalised.push(subtag)
  }
  return normalised.join('-')
}
