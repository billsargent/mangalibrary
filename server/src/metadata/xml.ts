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

/** An element as it was written: its opening tag, and the markup inside it. */
export interface XmlElement {
  /** The opening tag, so a caller can read its attributes. */
  tag: string
  /** The raw markup between the tags, entities and all. */
  inner: string
}

/**
 * Every `<name>` element, in document order.
 *
 * The name is matched with or without a namespace prefix, because an EPUB writes
 * its metadata as `dc:title` in one package document and `title` in the next, and
 * both mean the same thing.
 */
export function elementsNamed(xml: string, name: string): XmlElement[] {
  // `<meta name="cover" content="c"/>` closes itself. Taken for an opening tag it
  // would run on to the next `</meta>` and swallow whatever lay between.
  const pattern = new RegExp(
    `<((?:[\\w.-]+:)?${name})\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>([\\s\\S]*?)</\\1\\s*>)`,
    'gi',
  )
  return [...xml.matchAll(pattern)].map((match) => ({
    tag: `<${match[1]}${match[2] ?? ''}>`,
    inner: match[3] ?? '',
  }))
}

/** The value of an attribute of an opening tag, or null when it is not there. */
export function attribute(tag: string, name: string): string | null {
  // The name is a whole word - `id` is not the end of `guid` - and the value may be
  // quoted either way.
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? null : unescapeXml(value)
}

/**
 * Markup reduced to the text it carries, as a reader would show it.
 *
 * An HTML description arrives either as markup or escaped as text, so the entities
 * are resolved first as well as afterwards: whichever way it was written, what is
 * left is the words.
 */
export function plainText(markup: string): string {
  const resolved = unescapeXml(withoutCdata(markup))
  return unescapeXml(resolved.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The text of the first `<name>` element, or null when it is absent or blank.
 *
 * A self-closing `<Name/>` has no text, and an element that appears twice - which
 * a hand-written document sometimes does - is read once, the first time, as an XML
 * reader taking the first of a repeated mapping would.
 */
export function elementText(xml: string, name: string): string | null {
  const element = elementsNamed(xml, name)[0]
  if (element === undefined) return null

  const text = unescapeXml(withoutCdata(element.inner)).trim()
  return text === '' ? null : text
}

/**
 * The text of the first `<name>` element with any markup inside it removed.
 *
 * An EPUB writes its description as HTML, so what is wanted there is the words a
 * reader would see rather than the markup that carries them.
 */
export function elementPlainText(xml: string, name: string): string | null {
  const element = elementsNamed(xml, name)[0]
  if (element === undefined) return null

  const text = plainText(element.inner)
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
