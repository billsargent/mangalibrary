import { defineMessages, type MessageDescriptor } from 'vue-intl'
import type { PageDto } from '@/generated/openapi'

/** How a page is fitted to the window in the paged reader. */
export const ScaleTypeValues = [
  'SCREEN',
  'WIDTH',
  'WIDTH_SHRINK_ONLY',
  'HEIGHT',
  'ORIGINAL',
] as const
export type ScaleType = (typeof ScaleTypeValues)[number]

export const scaleTypeMessages: Record<ScaleType, MessageDescriptor> = defineMessages({
  SCREEN: {
    description: 'Reader scale type: fit to screen',
    defaultMessage: 'Fit to screen',
    id: 'enum.ReaderScaleType.SCREEN',
  },
  WIDTH: {
    description: 'Reader scale type: fit to width',
    defaultMessage: 'Fit to width',
    id: 'enum.ReaderScaleType.WIDTH',
  },
  WIDTH_SHRINK_ONLY: {
    description: 'Reader scale type: fit to width, shrink only',
    defaultMessage: 'Fit to width (shrink only)',
    id: 'enum.ReaderScaleType.WIDTH_SHRINK_ONLY',
  },
  HEIGHT: {
    description: 'Reader scale type: fit to height',
    defaultMessage: 'Fit to height',
    id: 'enum.ReaderScaleType.HEIGHT',
  },
  ORIGINAL: {
    description: 'Reader scale type: original size',
    defaultMessage: 'Original',
    id: 'enum.ReaderScaleType.ORIGINAL',
  },
})

/** How a page is sized in the continuous (webtoon) reader. */
export const ContinuousScaleTypeValues = ['WIDTH', 'ORIGINAL'] as const
export type ContinuousScaleType = (typeof ContinuousScaleTypeValues)[number]

export const continuousScaleTypeMessages: Record<ContinuousScaleType, MessageDescriptor> =
  defineMessages({
    WIDTH: {
      description: 'Continuous reader scale type: fit to width',
      defaultMessage: 'Fit to width',
      id: 'enum.ReaderContinuousScaleType.WIDTH',
    },
    ORIGINAL: {
      description: 'Continuous reader scale type: original size',
      defaultMessage: 'Original',
      id: 'enum.ReaderContinuousScaleType.ORIGINAL',
    },
  })

/** How many pages the paged reader shows side by side. */
export const PageLayoutValues = ['SINGLE_PAGE', 'DOUBLE_PAGES', 'DOUBLE_NO_COVER'] as const
export type PageLayout = (typeof PageLayoutValues)[number]

export const pageLayoutMessages: Record<PageLayout, MessageDescriptor> = defineMessages({
  SINGLE_PAGE: {
    description: 'Reader page layout: single page',
    defaultMessage: 'Single page',
    id: 'enum.ReaderPageLayout.SINGLE_PAGE',
  },
  DOUBLE_PAGES: {
    description: 'Reader page layout: double pages, the cover alone',
    defaultMessage: 'Double pages',
    id: 'enum.ReaderPageLayout.DOUBLE_PAGES',
  },
  DOUBLE_NO_COVER: {
    description: 'Reader page layout: double pages, the first page paired like the rest',
    defaultMessage: 'Double pages (no cover)',
    id: 'enum.ReaderPageLayout.DOUBLE_NO_COVER',
  },
})

/** Side padding of the continuous reader, as a percentage of the window on each side. */
export const PaddingPercentages = [0, 5, 10, 15, 20, 25, 30, 35, 40] as const
/** Gap between two pages of the continuous reader, in pixels. */
export const PageMargins = [0, 5, 10, 15] as const

export const BackgroundColors = ['white', '#212121', 'black'] as const
export type BackgroundColor = (typeof BackgroundColors)[number]

export const backgroundColorMessages: Record<BackgroundColor, MessageDescriptor> = defineMessages({
  white: {
    description: 'Reader background colour: white',
    defaultMessage: 'White',
    id: 'enum.ReaderBackground.white',
  },
  '#212121': {
    description: 'Reader background colour: gray',
    defaultMessage: 'Gray',
    id: 'enum.ReaderBackground.gray',
  },
  black: {
    description: 'Reader background colour: black',
    defaultMessage: 'Black',
    id: 'enum.ReaderBackground.black',
  },
})

/**
 * A page as the reader shows it: the page the server describes, and where its image is.
 *
 * A blank page has no image. It stands beside a page that has no partner in a
 * double-page spread - the cover, a page before a landscape one - so that page keeps
 * to its own half of the window instead of sliding to the middle.
 */
export type ReaderPage = Pick<PageDto, 'number' | 'width' | 'height' | 'mediaType' | 'fileName'> & {
  url: string
  blank?: boolean
}

/** Where the reader was opened from, which decides what the next book is. */
export type ReaderContext = { origin: 'READLIST'; id: string } | undefined
