import { defineStore } from 'pinia'
import type { ReadingDirection } from '@/types/ReadingDirection'
import type { BackgroundColor, ContinuousScaleType, PageLayout, ScaleType } from '@/types/reader'

/**
 * The reader's preferences.
 *
 * They are kept in the browser, as the legacy reader kept them: how a book is best
 * read depends on the screen it is read on, so a phone and a desktop each remember
 * their own.
 */
export const useReaderStore = defineStore(
  'reader',
  () => {
    const readingDirection = ref<ReadingDirection>('LEFT_TO_RIGHT')
    // What the reader picked for a series whose metadata names another direction,
    // by series id, so the metadata does not undo the choice at every book.
    const seriesDirections = ref<Record<string, ReadingDirection>>({})
    const animations = ref(true)
    const swipe = ref(false)
    const alwaysFullscreen = ref(false)
    const background = ref<BackgroundColor>('black')

    const pagedScale = ref<ScaleType>('SCREEN')
    const pageLayout = ref<PageLayout>('SINGLE_PAGE')

    const continuousScale = ref<ContinuousScaleType>('WIDTH')
    const continuousPadding = ref(0)
    const continuousMargin = ref(0)

    return {
      readingDirection,
      seriesDirections,
      animations,
      swipe,
      alwaysFullscreen,
      background,
      pagedScale,
      pageLayout,
      continuousScale,
      continuousPadding,
      continuousMargin,
    }
  },
  {
    persist: {
      key: 'mangalibrary.reader',
    },
  },
)
