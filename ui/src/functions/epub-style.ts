import type { EpubFont, EpubLayout, EpubTheme } from '@/stores/epub-reader'

/** The colours of a reading theme. */
export const EPUB_THEMES: Record<EpubTheme, { background: string; text: string; link: string }> = {
  light: { background: '#ffffff', text: '#1c1b1f', link: '#1a56b0' },
  sepia: { background: '#f4ecd8', text: '#5b4636', link: '#8a4b12' },
  dark: { background: '#121212', text: '#d9d9d9', link: '#8ab4f8' },
}

const FONTS: Record<Exclude<EpubFont, 'publisher'>, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
}

/** Space around the text, in pixels: at the sides, and above and below. */
export const EPUB_GUTTER = { side: 28, top: 20 } as const

export interface EpubStyleSettings {
  theme: EpubTheme
  layout: EpubLayout
  font: EpubFont
  fontSize: number
}

/**
 * The stylesheet the reader adds to a chapter.
 *
 * A book's own styles stay; these go over them. Paginated, the chapter is laid
 * out in columns one window wide and as tall as the window, so that the text
 * runs sideways and a page is one step of the window's width. Scrolled, it is
 * left as a document and the window scrolls down it.
 */
export function epubStyle(settings: EpubStyleSettings): string {
  const theme = EPUB_THEMES[settings.theme]
  const { side, top } = EPUB_GUTTER

  const common = `
    html {
      font-size: ${settings.fontSize}% !important;
      background: ${theme.background} !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    body {
      background: ${theme.background} !important;
      color: ${theme.text} !important;
      box-sizing: border-box !important;
      max-width: none !important;
      overflow-wrap: break-word;
    }
    ${settings.theme === 'light' ? '' : `body * { color: inherit !important; background-color: transparent !important; }`}
    a, a * { color: ${theme.link} !important; }
    ${
      settings.font === 'publisher'
        ? ''
        : `body, body p, body div, body span, body li, body td, body blockquote { font-family: ${FONTS[settings.font]} !important; }`
    }
    img, svg, video { max-width: 100% !important; height: auto; }
  `

  if (settings.layout === 'scrolled') {
    return `${common}
    html { overflow-x: hidden !important; }
    body { margin: 0 !important; padding: ${top}px ${side}px ${top * 3}px !important; }
    `
  }

  return `${common}
    html { height: 100% !important; overflow: hidden !important; }
    body {
      margin: 0 !important;
      padding: ${top}px ${side}px !important;
      width: 100vw !important;
      height: 100vh !important;
      column-width: calc(100vw - ${side * 2}px) !important;
      column-gap: ${side * 2}px !important;
      column-fill: auto !important;
      overflow: visible !important;
    }
    img, svg, video {
      max-height: calc(100vh - ${top * 2}px) !important;
      object-fit: contain;
      break-inside: avoid;
    }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  `
}
