/**
 * ISBNs, as they turn up in a book's metadata.
 *
 * ComicInfo carries one in `GTIN`, an EPUB in `dc:identifier`, and neither
 * promises a well-formed value, so both go through here before anything is
 * stored: the digits are separated from the dressing, and the check digit is
 * checked. What survives is the ISBN without hyphens, which is what a search or a
 * provider hand-off wants.
 */

/** Drop the hyphens and spaces an ISBN is usually written with. */
function digitsOf(value: string): string {
  return value.replace(/[-\s]/g, '')
}

/** The check digit of an ISBN-10, whose last character may be `X` for ten. */
function isIsbn10(isbn: string): boolean {
  if (!/^\d{9}[\dX]$/i.test(isbn)) return false

  let sum = 0
  for (const [index, character] of [...isbn].entries()) {
    const value = character.toUpperCase() === 'X' ? 10 : Number(character)
    sum += (10 - index) * value
  }
  return sum % 11 === 0
}

/** The check digit of an ISBN-13, which alternates weights of one and three. */
function isIsbn13(isbn: string): boolean {
  if (!/^\d{13}$/.test(isbn)) return false

  let sum = 0
  for (const [index, character] of [...isbn].entries()) {
    sum += Number(character) * (index % 2 === 0 ? 1 : 3)
  }
  return sum % 10 === 0
}

/**
 * The ISBN a value is, or null when it is not one.
 *
 * A value that is not an ISBN is not an error worth reporting: a book's
 * identifier is often a UUID or a URL, and the metadata simply keeps what it had.
 */
export function validatedIsbn(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const isbn = digitsOf(value.trim())
  return isIsbn10(isbn) || isIsbn13(isbn) ? isbn : null
}
