import { defineStore } from 'pinia'

export const EpubThemeValues = ['light', 'sepia', 'dark'] as const
export type EpubTheme = (typeof EpubThemeValues)[number]

export const EpubLayoutValues = ['paginated', 'scrolled'] as const
export type EpubLayout = (typeof EpubLayoutValues)[number]

export const EpubFontValues = ['publisher', 'serif', 'sans'] as const
export type EpubFont = (typeof EpubFontValues)[number]

/** One page at a time, two side by side, or two when the window is wide enough. */
export const EpubSpreadValues = ['auto', 'single', 'double'] as const
export type EpubSpread = (typeof EpubSpreadValues)[number]

export const EpubMarginValues = ['narrow', 'normal', 'wide'] as const
export type EpubMargins = (typeof EpubMarginValues)[number]

/** Line spacing: 0 keeps the book's own. */
export const EpubLineHeightValues = [0, 1.2, 1.5, 1.8, 2.1] as const

export const EPUB_FONT_SIZE = { min: 60, max: 250, step: 10, default: 100 } as const

/**
 * The EPUB reader's preferences, kept in the browser like the comic reader's: how
 * text is best read depends on the screen it is read on.
 */
export const useEpubReaderStore = defineStore(
  'epub-reader',
  () => {
    const theme = ref<EpubTheme>('light')
    const layout = ref<EpubLayout>('paginated')
    const font = ref<EpubFont>('publisher')
    /** Text size, as a percentage of the book's own. */
    const fontSize = ref<number>(EPUB_FONT_SIZE.default)
    const spread = ref<EpubSpread>('auto')
    const margins = ref<EpubMargins>('normal')
    const lineHeight = ref<number>(0)
    /** What this browser calls itself when it tells the server where a reader is. */
    const deviceId = ref('')

    return { theme, layout, font, fontSize, spread, margins, lineHeight, deviceId }
  },
  {
    persist: {
      key: 'mangalibrary.epub-reader',
    },
  },
)
