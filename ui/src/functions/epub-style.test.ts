import { describe, expect, it } from 'vitest'
import { epubStyle, wideEnoughForTwo, type EpubStyleSettings } from './epub-style'

const settings: EpubStyleSettings = {
  theme: 'light',
  layout: 'paginated',
  font: 'publisher',
  fontSize: 100,
  columns: 1,
  margins: 'normal',
  lineHeight: 0,
}

describe('epubStyle', () => {
  it('lays a page out one window wide, or two pages to a window', () => {
    expect(epubStyle(settings)).toContain('column-width: calc(100vw - 56px)')
    const two = epubStyle({ ...settings, columns: 2 })
    expect(two).toContain('column-count: 2')
    expect(two).not.toContain('column-width: calc')
  })

  it('keeps the margins it is given at the sides', () => {
    expect(epubStyle({ ...settings, margins: 'narrow' })).toContain('padding: 20px 12px')
    expect(epubStyle({ ...settings, margins: 'wide' })).toContain('padding: 20px 72px')
  })

  it("keeps the book's line spacing unless told otherwise", () => {
    expect(epubStyle(settings)).not.toContain('line-height')
    expect(epubStyle({ ...settings, lineHeight: 1.8 })).toContain('line-height: 1.8 !important')
  })
})

describe('wideEnoughForTwo', () => {
  it('wants a wide window in landscape', () => {
    expect(wideEnoughForTwo(1400, 900)).toBe(true)
    expect(wideEnoughForTwo(900, 600)).toBe(false)
    expect(wideEnoughForTwo(1200, 1600)).toBe(false)
  })
})
