import { describe, expect, it } from 'vitest'
import { contentDisposition } from './content-disposition.js'

/** What Node accepts as a header value: nothing above U+00FF, no control characters. */
const HEADER_SAFE = /^[\t\x20-\x7e\x80-\xff]*$/

describe('contentDisposition', () => {
  it('writes a plain name in both forms', () => {
    expect(contentDisposition('attachment', 'Akira v01.cbz')).toBe(
      `attachment; filename="Akira v01.cbz"; filename*=UTF-8''Akira%20v01.cbz`,
    )
  })

  it('keeps a name that is not Latin-1 out of the quoted form and whole in the extended one', () => {
    const header = contentDisposition('inline', '進撃の巨人 v01.cbz')

    expect(header).toMatch(HEADER_SAFE)
    expect(header).toContain('filename="_____ v01.cbz"')
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? '')).toBe('進撃の巨人 v01.cbz')
  })

  it('does not let a quote or a backslash end the quoted form early', () => {
    const header = contentDisposition('attachment', 'He said "no" \\ maybe.cbz')

    expect(header).toContain(`filename="He said 'no' ' maybe.cbz"`)
  })

  it('encodes the characters an extended value may not hold bare', () => {
    const header = contentDisposition('attachment', "Rock’n'Roll (1) *.cbz")
    const extended = header.split("filename*=UTF-8''")[1] ?? ''

    expect(header).toMatch(HEADER_SAFE)
    expect(extended).not.toMatch(/['()*]/)
    expect(decodeURIComponent(extended)).toBe("Rock’n'Roll (1) *.cbz")
  })

  it('survives half of a surrogate pair', () => {
    expect(() => contentDisposition('attachment', 'broken \uD83D name.cbz')).not.toThrow()
  })
})
