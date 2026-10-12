import { defineStore } from 'pinia'

export const EpubThemeValues = ['light', 'sepia', 'dark'] as const
export type EpubTheme = (typeof EpubThemeValues)[number]

export const EpubLayoutValues = ['paginated', 'scrolled'] as const
export type EpubLayout = (typeof EpubLayoutValues)[number]

export const EpubFontValues = ['publisher', 'serif', 'sans'] as const
export type EpubFont = (typeof EpubFontValues)[number]

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
    /** What this browser calls itself when it tells the server where a reader is. */
    const deviceId = ref('')

    return { theme, layout, font, fontSize, deviceId }
  },
  {
    persist: {
      key: 'mangalibrary.epub-reader',
    },
  },
)
