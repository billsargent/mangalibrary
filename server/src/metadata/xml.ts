/**
 * Reading the small, fixed XML documents a book carries.
 *
 * The same choice as the EPUB reader and the ComicRack reading list: these
 * documents are read with targeted patterns rather than by taking on an XML
 * dependency, because the shapes involved are a flat list of elements whose text
 * is wanted, not a tree.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Turn the character references a document may use back into characters. */
export function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (whole: string, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
      return NAMED_ENTITIES[(named ?? '').toLowerCase()] ?? whole
    },
  )
}

/** The inside of a `CDATA` section, if the text is one. */
function withoutCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/**
 * The text of the first `<name>` element, or null when it is absent or blank.
 *
 * A self-closing `<Name/>` has no text, and an element that appears twice - which
 * a hand-written document sometimes does - is read once, the first time, as an XML
 * reader taking the first of a repeated mapping would.
 */
export function elementText(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml)
  if (match === null) return null

  const text = unescapeXml(withoutCdata(match[1] ?? '')).trim()
  return text === '' ? null : text
}

/** The text of an element as a whole number, or null when it is not one. */
export function elementInt(xml: string, name: string): number | null {
  const text = elementText(xml, name)
  if (text === null || !/^[+-]?\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/** The text of an element as a number, or null when it is not one. */
export function elementFloat(xml: string, name: string): number | null {
  const text = elementText(xml, name)
  if (text === null || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}
