<template>
  <div
    class="reader"
    :style="{ backgroundColor: store.background }"
  >
    <EmptyStateNetworkError v-if="error" />

    <v-progress-linear
      v-else-if="!ready"
      indeterminate
      color="primary"
    />

    <template v-else>
      <v-slide-y-transition>
        <v-toolbar
          v-if="showToolbars"
          density="compact"
          elevation="1"
          class="bar bar--top"
        >
          <v-btn
            icon="i-mdi:arrow-left"
            :aria-label="$formatMessage(messages.close)"
            @click="closeBook()"
          />
          <v-toolbar-title>{{ title }}</v-toolbar-title>

          <v-icon
            v-if="incognito"
            :title="$formatMessage(messages.incognito)"
            icon="i-mdi:incognito"
            class="mx-2"
          />
          <v-btn
            :icon="isFullscreen ? 'i-mdi:fullscreen-exit' : 'i-mdi:fullscreen'"
            :disabled="!fullscreenSupported"
            :aria-label="$formatMessage(messages.fullscreen)"
            @click="toggleFullscreen()"
          />
          <v-btn
            icon="i-mdi:help-circle"
            :aria-label="$formatMessage(messages.showHelp)"
            @click="showHelp = !showHelp"
          />
          <v-btn
            icon="i-mdi:view-grid"
            :aria-label="$formatMessage(messages.showThumbnails)"
            @click="showExplorer = !showExplorer"
          />
          <v-btn
            icon="i-mdi:cog"
            :aria-label="$formatMessage(messages.showSettings)"
            @click="showSettings = !showSettings"
          />

          <v-menu>
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                icon="i-mdi:dots-vertical"
                :aria-label="$formatMessage(commonMessages.buttonMore)"
              />
            </template>
            <v-list>
              <v-list-item
                :title="
                  $formatMessage({
                    description: 'Reader menu: download the page on screen',
                    defaultMessage: 'Download current page',
                    id: '9nbGsJ',
                  })
                "
                :href="`${currentPage?.url.split('?')[0]}?contentNegotiation=false`"
                :download="`${book!.name}-${page}.${currentPage?.fileName.split('.').pop()}`"
              />
              <template v-if="isAdmin">
                <v-list-item
                  :title="
                    $formatMessage({
                      description: 'Reader menu: use the page on screen as the poster of the book',
                      defaultMessage: 'Set current page as book poster',
                      id: 'zS535x',
                    })
                  "
                  @click="setPoster('book')"
                />
                <v-list-item
                  v-if="!book!.oneshot"
                  :title="
                    $formatMessage({
                      description:
                        'Reader menu: use the page on screen as the poster of the series',
                      defaultMessage: 'Set current page as series poster',
                      id: '6ajff4',
                    })
                  "
                  @click="setPoster('series')"
                />
              </template>
            </v-list>
          </v-menu>
        </v-toolbar>
      </v-slide-y-transition>

      <v-slide-y-reverse-transition>
        <v-toolbar
          v-if="showToolbars"
          density="compact"
          elevation="1"
          class="bar bar--bottom px-2"
        >
          <v-btn
            icon="i-mdi:undo"
            :disabled="!previousBook"
            :aria-label="$formatMessage(messages.previousBook)"
            @click="goToPreviousBook()"
          />
          <v-btn
            icon="i-mdi:skip-previous"
            :aria-label="$formatMessage(messages.firstPage)"
            @click="goTo(1)"
          />
          <span class="mx-2 text-body-medium">{{ page }}</span>
          <v-slider
            v-model="sliderPage"
            :min="1"
            :max="pageCount"
            :step="1"
            :reverse="direction === 'RIGHT_TO_LEFT'"
            thumb-label
            hide-details
            @end="goTo(sliderPage)"
          />
          <span class="mx-2 text-body-medium">{{ pageCount }}</span>
          <v-btn
            icon="i-mdi:skip-next"
            :aria-label="$formatMessage(messages.lastPage)"
            @click="goTo(pageCount)"
          />
          <v-btn
            icon="i-mdi:redo"
            :aria-label="$formatMessage(messages.nextBook)"
            @click="goToNextBook()"
          />
        </v-toolbar>
      </v-slide-y-reverse-transition>

      <ReaderContinuous
        v-if="isContinuous"
        v-model:page="page"
        :pages="pages"
        :scale="store.continuousScale"
        :side-padding="store.continuousPadding"
        :page-margin="store.continuousMargin"
        :animations="store.animations"
        :disabled="dialogOpen"
        @menu="showToolbars = !showToolbars"
        @jump-previous="jumpToPrevious()"
        @jump-next="jumpToNext()"
      />
      <ReaderPaged
        v-else
        v-model:page="page"
        :pages="pages"
        :reading-direction="direction"
        :page-layout="store.pageLayout"
        :scale="store.pagedScale"
        :animations="store.animations"
        :swipe="store.swipe"
        :disabled="dialogOpen"
        @menu="showToolbars = !showToolbars"
        @jump-previous="jumpToPrevious()"
        @jump-next="jumpToNext()"
      />

      <ReaderThumbnails
        v-model="showExplorer"
        :book-id="bookId"
        :page-count="pageCount"
        :current-page="page"
        @go="goTo"
      />
      <ReaderSettings
        v-model="showSettings"
        v-model:reading-direction="chosenDirection"
        :fullscreen-supported="fullscreenSupported"
      />
      <ReaderShortcutsHelp
        v-model="showHelp"
        :groups="shortcutGroups"
      />

      <v-snackbar
        v-model="askPreviousBook"
        :timeout="JUMP_CONFIRMATION_MS"
        location="top"
        multi-line
      >
        <p>
          {{
            $formatMessage({
              description: 'Reader: shown when going back from the first page',
              defaultMessage: 'You are at the beginning of the book.',
              id: 'qSbZ1n',
            })
          }}
        </p>
        <p v-if="previousBook">
          {{
            $formatMessage({
              description: 'Reader: how to go to the previous book',
              defaultMessage: 'Click or press previous again to move to the previous book.',
              id: 'WRC8hB',
            })
          }}
        </p>
      </v-snackbar>

      <v-snackbar
        v-model="askNextBook"
        :timeout="JUMP_CONFIRMATION_MS"
        location="top"
        multi-line
      >
        <p>
          {{
            $formatMessage({
              description: 'Reader: shown when going forward from the last page',
              defaultMessage: 'You have reached the end of the book.',
              id: 'xLd5Qi',
            })
          }}
        </p>
        <p v-if="nextBook">
          {{
            $formatMessage({
              description: 'Reader: how to go to the next book',
              defaultMessage: 'Click or press next again to move to the next book.',
              id: 'AJ7eP6',
            })
          }}
        </p>
        <p v-else>
          {{
            $formatMessage({
              description: 'Reader: how to leave after the last book',
              defaultMessage: 'Click or press next again to exit the reader.',
              id: '+xj+4o',
            })
          }}
        </p>
      </v-snackbar>

      <v-snackbar
        v-model="notice.shown"
        :timeout="notice.timeout"
        location="bottom"
      >
        {{ notice.text }}
      </v-snackbar>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { useQuery } from '@pinia/colada'
import { useDebounceFn, useEventListener, useFullscreen } from '@vueuse/core'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
import { bookDetailQuery, bookPagesQuery, QUERY_KEYS_BOOKS, useAddBookPoster } from '@/colada/books'
import { clearBook } from '@/colada/cache'
import { seriesDetailQuery, useAddSeriesPoster } from '@/colada/series'
import { useCurrentUser } from '@/colada/users'
import EmptyStateNetworkError from '@/components/EmptyStateNetworkError.vue'
import type { ShortcutGroup } from '@/components/reader/ShortcutsHelp.vue'
import { bookTitleCompact, clampPage, cycle, toReaderPages } from '@/functions/reader'
import {
  type BookDto,
  komgaGetBookSiblingNext,
  komgaGetBookSiblingNextInReadList,
  komgaGetBookSiblingPrevious,
  komgaGetBookSiblingPreviousInReadList,
  komgaMarkBookReadProgress,
} from '@/generated/openapi'
import { useReaderStore } from '@/stores/reader'
import {
  type ReadingDirection,
  readingDirectionMessages,
  ReadingDirectionValues,
} from '@/types/ReadingDirection'
import {
  continuousScaleTypeMessages,
  ContinuousScaleTypeValues,
  PaddingPercentages,
  pageLayoutMessages,
  PageLayoutValues,
  PageMargins,
  type ReaderContext,
  scaleTypeMessages,
  ScaleTypeValues,
} from '@/types/reader'
import { commonMessages } from '@/utils/i18n/common-messages'

/**
 * The reader for books that are a sequence of images: comics, manga, webtoons, and
 * PDFs and EPUBs that are made of pictures.
 *
 * This page owns the book - which one, which page, where it was opened from - and
 * everything around the pages: the toolbars, the dialogs, the keyboard, reading
 * progress. Showing the pages is left to one of two components, by reading direction.
 */

const messages = defineMessages({
  close: {
    description: 'Reader: close the book',
    defaultMessage: 'Close',
    id: 'Xl+4Wy',
  },
  incognito: {
    description: 'Reader: tooltip of the incognito icon',
    defaultMessage: 'Incognito mode: read progress will not be marked',
    id: 'ZlYQlu',
  },
  fullscreen: {
    description: 'Reader: full screen button and shortcut',
    defaultMessage: 'Full screen',
    id: 'zxE3B/',
  },
  showHelp: {
    description: 'Reader: keyboard shortcuts button and shortcut',
    defaultMessage: 'Show or hide help',
    id: 'Wrc2ey',
  },
  showThumbnails: {
    description: 'Reader: page explorer button and shortcut',
    defaultMessage: 'Show or hide the page explorer',
    id: 'KI56Ch',
  },
  showSettings: {
    description: 'Reader: settings button and shortcut',
    defaultMessage: 'Show or hide settings',
    id: 'DLjR22',
  },
  previousBook: {
    description: 'Reader: go to the previous book',
    defaultMessage: 'Previous book',
    id: '3J3Sbx',
  },
  nextBook: {
    description: 'Reader: go to the next book',
    defaultMessage: 'Next book',
    id: 'N5LtZ4',
  },
  firstPage: {
    description: 'Reader: go to the first page',
    defaultMessage: 'First page',
    id: 'NoRj7h',
  },
  lastPage: {
    description: 'Reader: go to the last page',
    defaultMessage: 'Last page',
    id: 'qcZK0O',
  },
  none: {
    description: 'Reader: no padding or margin',
    defaultMessage: 'None',
    id: 'RpleRj',
  },
  posterSetBook: {
    description: 'Reader: notice after setting the book poster',
    defaultMessage: 'Current page set as book poster',
    id: 'v6K9UZ',
  },
  posterSetSeries: {
    description: 'Reader: notice after setting the series poster',
    defaultMessage: 'Current page set as series poster',
    id: 'iNVr5/',
  },
  keyPreviousPage: {
    description: 'Reader shortcut: previous page',
    defaultMessage: 'Previous page',
    id: 'VdfmY6',
  },
  keyNextPage: {
    description: 'Reader shortcut: next page',
    defaultMessage: 'Next page',
    id: 'rqjoVt',
  },
  keyCycleScale: {
    description: 'Reader shortcut: cycle scale',
    defaultMessage: 'Cycle scale',
    id: '6o7oFN',
  },
  keyCycleLayout: {
    description: 'Reader shortcut: cycle page layout',
    defaultMessage: 'Cycle page layout',
    id: 'kZ/ecO',
  },
  keyCyclePadding: {
    description: 'Reader shortcut: cycle side padding',
    defaultMessage: 'Cycle side padding',
    id: '7IpTnQ',
  },
  keyCycleMargin: {
    description: 'Reader shortcut: cycle page margin',
    defaultMessage: 'Cycle page margin',
    id: 'yl2ic7',
  },
  keyToolbars: {
    description: 'Reader shortcut: show or hide the toolbars',
    defaultMessage: 'Show or hide toolbars',
    id: 'A+cB93',
  },
  groupNavigation: {
    description: 'Reader shortcuts: navigation group',
    defaultMessage: 'Reader navigation',
    id: '88oP6X',
  },
  groupSettings: {
    description: 'Reader shortcuts: settings group',
    defaultMessage: 'Settings',
    id: 'S6+Ruz',
  },
  groupMenus: {
    description: 'Reader shortcuts: menus group',
    defaultMessage: 'Menus',
    id: '6aeqyq',
  },
})

/**
 * The messages that take a value. They are typed as plain descriptors: a message
 * declared through `defineMessages` alone is taken to have no values at all.
 */
const valueMessages: Record<
  | 'directionFromSeries'
  | 'changedDirection'
  | 'changedScale'
  | 'changedLayout'
  | 'changedPadding'
  | 'changedMargin',
  MessageDescriptor
> = defineMessages({
  directionFromSeries: {
    description: 'Reader: notice of the reading direction, when the series decides it',
    defaultMessage: '{direction} (from series metadata)',
    id: 'u4eWbl',
  },
  changedDirection: {
    description: 'Reader: notice after changing the reading direction with a key',
    defaultMessage: 'Changing reading direction: {direction}',
    id: 'CO471E',
  },
  changedScale: {
    description: 'Reader: notice after changing the scale with a key',
    defaultMessage: 'Cycling scale: {scale}',
    id: '+2U4xm',
  },
  changedLayout: {
    description: 'Reader: notice after changing the page layout with a key',
    defaultMessage: 'Cycling page layout: {layout}',
    id: 'UfRb7k',
  },
  changedPadding: {
    description: 'Reader: notice after changing the side padding with a key',
    defaultMessage: 'Cycling side padding: {padding}',
    id: 'U6GPZV',
  },
  changedMargin: {
    description: 'Reader: notice after changing the page margin with a key',
    defaultMessage: 'Cycling page margin: {margin}',
    id: 'g9xLQw',
  },
})

/** How long "press again to go to the next book" waits for the second press. */
const JUMP_CONFIRMATION_MS = 3000

const route = useRoute('/book.[id].read')
const router = useRouter()
const intl = useIntl()
const store = useReaderStore()
const { isAdmin } = useCurrentUser()

const bookId = computed(() => route.params.id)

/** Reading without leaving a trace: no progress is recorded. */
const incognito = computed(() => String(route.query.incognito).toLowerCase() === 'true')

/** A book opened from a read list goes on to the next book of that list, not of its series. */
const context = computed<ReaderContext>(() => {
  const id = route.query.contextId
  if (route.query.context === 'READLIST' && typeof id === 'string' && id !== '')
    return { origin: 'READLIST', id }
  return undefined
})

//region The book

const { data: book, error: bookError } = useQuery(() => bookDetailQuery({ bookId: bookId.value }))
const { data: series, error: seriesError } = useQuery(() => ({
  ...seriesDetailQuery({ seriesId: book.value?.seriesId ?? '' }),
  enabled: !!book.value,
}))
const { data: pageDtos, error: pagesError } = useQuery(() =>
  bookPagesQuery({ bookId: bookId.value }),
)

const error = computed(() => bookError.value ?? seriesError.value ?? pagesError.value)

const pages = computed(() => toReaderPages(bookId.value, pageDtos.value ?? []))
const pageCount = computed(() => pages.value.length)

function siblingQuery(which: 'next' | 'previous') {
  return () => ({
    key: [...QUERY_KEYS_BOOKS.byId(bookId.value), 'reader', which, context.value?.id ?? 'series'],
    query: (): Promise<BookDto> => {
      const list = context.value
      if (list) {
        const path = { id: list.id, bookId: bookId.value }
        return which === 'next'
          ? komgaGetBookSiblingNextInReadList({ path })
          : komgaGetBookSiblingPreviousInReadList({ path })
      }
      const path = { bookId: bookId.value }
      return which === 'next'
        ? komgaGetBookSiblingNext({ path })
        : komgaGetBookSiblingPrevious({ path })
    },
  })
}
// The first and the last book have no neighbour on one side: the server answers
// 404, and the query's data stays undefined.
const { data: nextBook } = useQuery(siblingQuery('next'))
const { data: previousBook } = useQuery(siblingQuery('previous'))

//endregion

//region The page on screen

const page = ref(1)
const sliderPage = ref(1)
/** The book the current page belongs to, so a page is never recorded against another book. */
const openedBookId = ref<string>()

const ready = computed(
  () =>
    openedBookId.value === bookId.value &&
    !!book.value &&
    !!series.value &&
    book.value.id === bookId.value &&
    pageCount.value > 0,
)
const currentPage = computed(() => pages.value[page.value - 1])

const title = computed(() => {
  if (!book.value || !series.value) return ''
  return bookTitleCompact(
    book.value.metadata.title,
    series.value.metadata.title,
    book.value.oneshot ? undefined : book.value.metadata.number,
  )
})
useHead({ title: () => (title.value ? `${title.value} - Manga Library` : 'Manga Library') })

// Only the page is sent. Reaching the last one is what completes the book, and it is
// the server that draws that conclusion.
const markProgress = useDebounceFn((forBook: string, number: number) => {
  if (incognito.value) return
  void komgaMarkBookReadProgress({
    path: { bookId: forBook },
    body: { page: number },
  }).catch(() => {
    // A page that could not be recorded is not worth interrupting the reading for.
  })
}, 50)

watch([page, ready], ([number, isReady]) => {
  if (!isReady) return
  sliderPage.value = number
  void markProgress(bookId.value, number)
  if (String(route.query.page) !== String(number)) {
    void router.replace({ query: { ...route.query, page: String(number) } })
  }
})

function goTo(number: number) {
  const target = clampPage(number, pageCount.value)
  if (target !== undefined) page.value = target
}

//endregion

//region Reading direction

/**
 * The direction the book is read in.
 *
 * It is the reader's preference, unless the series says how it is meant to be read:
 * that applies to this book without replacing the preference. A direction the
 * reader then picks is theirs, and is kept.
 */
const direction = ref<ReadingDirection>(store.readingDirection)
const isContinuous = computed(() => direction.value === 'WEBTOON')

const chosenDirection = computed({
  get: () => direction.value,
  set: (value) => {
    direction.value = value
    store.readingDirection = value
  },
})

function applySeriesDirection() {
  const fromSeries = series.value?.metadata.readingDirection as ReadingDirection | undefined
  const known = fromSeries !== undefined && ReadingDirectionValues.includes(fromSeries)
  direction.value = known ? fromSeries : store.readingDirection

  const name = intl.formatMessage(readingDirectionMessages[direction.value])
  notify(
    known && fromSeries !== store.readingDirection
      ? intl.formatMessage(valueMessages.directionFromSeries, { direction: name })
      : name,
    3000,
  )
}

//endregion

//region Moving between books

const askNextBook = ref(false)
const askPreviousBook = ref(false)

function readRoute(target: BookDto) {
  const epub =
    target.media.mediaProfile.toLowerCase() === 'epub' && !target.media.epubDivinaCompatible
  const query: Record<string, string> = { incognito: String(incognito.value) }
  if (context.value) {
    query.context = context.value.origin
    query.contextId = context.value.id
  }
  return {
    name: epub ? ('/book.[id].read-epub' as const) : ('/book.[id].read' as const),
    params: { id: target.id },
    query,
  }
}

function closeBook() {
  void router.push({ name: '/book/[id]', params: { id: bookId.value } })
}

function goToPreviousBook() {
  if (previousBook.value) void router.push(readRoute(previousBook.value))
}

function goToNextBook() {
  if (nextBook.value) void router.push(readRoute(nextBook.value))
  else closeBook()
}

// Turning past either end of a book asks first, and goes on the second time.
function jumpToPrevious() {
  if (askPreviousBook.value) goToPreviousBook()
  else askPreviousBook.value = true
}

function jumpToNext() {
  if (askNextBook.value) goToNextBook()
  else askNextBook.value = true
}

//endregion

//region Toolbars, dialogs and notices

const showToolbars = ref(false)
const showSettings = ref(false)
const showExplorer = ref(false)
const showHelp = ref(false)
const dialogOpen = computed(() => showSettings.value || showExplorer.value || showHelp.value)

const notice = reactive({ shown: false, text: '', timeout: 4000 })
function notify(text: string, timeout = 4000) {
  notice.text = text
  notice.timeout = timeout
  notice.shown = true
}

const {
  isFullscreen,
  isSupported: fullscreenSupported,
  toggle: toggleFullscreen,
  enter: enterFullscreen,
  exit: exitFullscreen,
} = useFullscreen()

watch(
  () => store.alwaysFullscreen,
  (always) => {
    // A browser only goes full screen in answer to something the reader did, which
    // changing the setting is. On opening a book it may refuse, and that is fine.
    void (always ? enterFullscreen() : exitFullscreen()).catch(() => {})
  },
)

const { mutateAsync: addBookPoster } = useAddBookPoster()
const { mutateAsync: addSeriesPoster } = useAddSeriesPoster()

async function setPoster(target: 'book' | 'series') {
  const shown = currentPage.value
  if (!shown || !book.value) return
  try {
    const response = await fetch(`${shown.url.split('?')[0]}?convert=jpeg`, {
      credentials: 'include',
    })
    if (!response.ok) throw new Error(String(response.status))
    const file = new File([await response.blob()], 'poster.jpg', { type: 'image/jpeg' })
    if (target === 'book') {
      await addBookPoster({ bookId: book.value.id, file, selected: true })
      notify(intl.formatMessage(messages.posterSetBook))
    } else {
      await addSeriesPoster({ seriesId: book.value.seriesId, file, selected: true })
      notify(intl.formatMessage(messages.posterSetSeries))
    }
  } catch {
    notify(intl.formatMessage(commonMessages.somethingWentWrongTitle))
  }
}

//endregion

//region Keyboard

function changeDirection(value: ReadingDirection) {
  chosenDirection.value = value
  notify(
    intl.formatMessage(valueMessages.changedDirection, {
      direction: intl.formatMessage(readingDirectionMessages[value]),
    }),
  )
}

function cycleScale() {
  if (isContinuous.value) {
    store.continuousScale = cycle(ContinuousScaleTypeValues, store.continuousScale)
    notify(
      intl.formatMessage(valueMessages.changedScale, {
        scale: intl.formatMessage(continuousScaleTypeMessages[store.continuousScale]),
      }),
    )
  } else {
    store.pagedScale = cycle(ScaleTypeValues, store.pagedScale)
    notify(
      intl.formatMessage(valueMessages.changedScale, {
        scale: intl.formatMessage(scaleTypeMessages[store.pagedScale]),
      }),
    )
  }
}

function cyclePageLayout() {
  if (isContinuous.value) return
  store.pageLayout = cycle(PageLayoutValues, store.pageLayout)
  notify(
    intl.formatMessage(valueMessages.changedLayout, {
      layout: intl.formatMessage(pageLayoutMessages[store.pageLayout]),
    }),
  )
}

function cycleSidePadding() {
  if (!isContinuous.value) return
  store.continuousPadding = cycle(PaddingPercentages, store.continuousPadding)
  notify(
    intl.formatMessage(valueMessages.changedPadding, {
      padding:
        store.continuousPadding === 0
          ? intl.formatMessage(messages.none)
          : `${store.continuousPadding}%`,
    }),
  )
}

function cyclePageMargin() {
  if (!isContinuous.value) return
  store.continuousMargin = cycle(PageMargins, store.continuousMargin)
  notify(
    intl.formatMessage(valueMessages.changedMargin, {
      margin:
        store.continuousMargin === 0
          ? intl.formatMessage(messages.none)
          : `${store.continuousMargin}px`,
    }),
  )
}

/** Escape closes whatever is open on top, and the book itself when nothing is. */
function closeTopmost() {
  if (showHelp.value) showHelp.value = false
  else if (showExplorer.value) showExplorer.value = false
  else if (showSettings.value) showSettings.value = false
  else if (showToolbars.value) showToolbars.value = false
  else closeBook()
}

const keys: Record<string, () => void> = {
  l: () => changeDirection('LEFT_TO_RIGHT'),
  r: () => changeDirection('RIGHT_TO_LEFT'),
  v: () => changeDirection('VERTICAL'),
  w: () => changeDirection('WEBTOON'),
  c: cycleScale,
  f: () => void toggleFullscreen(),
  d: cyclePageLayout,
  p: cycleSidePadding,
  n: cyclePageMargin,
  m: () => (showToolbars.value = !showToolbars.value),
  s: () => (showSettings.value = !showSettings.value),
  t: () => (showExplorer.value = !showExplorer.value),
  h: () => (showHelp.value = !showHelp.value),
  Escape: closeTopmost,
  Home: () => goTo(1),
  End: () => goTo(pageCount.value),
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (!ready.value || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
  // Typing in a field of a dialog is typing, not a shortcut.
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && event.key !== 'Escape')
    return

  const action = keys[event.key]
  if (!action) return
  // With a dialog open, only the keys that open and close dialogs still act.
  if (dialogOpen.value && !['s', 't', 'h', 'Escape'].includes(event.key)) return
  event.preventDefault()
  action()
})

const shortcutGroups = computed<ShortcutGroup[]>(() => {
  const format = intl.formatMessage
  const navigation = {
    LEFT_TO_RIGHT: [
      { keys: '←', description: format(messages.keyPreviousPage) },
      { keys: '→', description: format(messages.keyNextPage) },
    ],
    RIGHT_TO_LEFT: [
      { keys: '→', description: format(messages.keyPreviousPage) },
      { keys: '←', description: format(messages.keyNextPage) },
    ],
    VERTICAL: [
      { keys: '↑', description: format(messages.keyPreviousPage) },
      { keys: '↓', description: format(messages.keyNextPage) },
    ],
    WEBTOON: [],
  }[direction.value]

  return [
    {
      title: format(messages.groupNavigation),
      shortcuts: [
        ...navigation,
        { keys: 'Home', description: format(messages.firstPage) },
        { keys: 'End', description: format(messages.lastPage) },
      ],
    },
    {
      title: format(messages.groupSettings),
      shortcuts: [
        { keys: 'L', description: format(readingDirectionMessages.LEFT_TO_RIGHT) },
        { keys: 'R', description: format(readingDirectionMessages.RIGHT_TO_LEFT) },
        { keys: 'V', description: format(readingDirectionMessages.VERTICAL) },
        { keys: 'W', description: format(readingDirectionMessages.WEBTOON) },
        { keys: 'C', description: format(messages.keyCycleScale) },
        { keys: 'F', description: format(messages.fullscreen) },
        ...(isContinuous.value
          ? [
              { keys: 'P', description: format(messages.keyCyclePadding) },
              { keys: 'N', description: format(messages.keyCycleMargin) },
            ]
          : [{ keys: 'D', description: format(messages.keyCycleLayout) }]),
      ],
    },
    {
      title: format(messages.groupMenus),
      shortcuts: [
        { keys: 'M', description: format(messages.keyToolbars) },
        { keys: 'S', description: format(messages.showSettings) },
        { keys: 'T', description: format(messages.showThumbnails) },
        { keys: 'H', description: format(messages.showHelp) },
        { keys: 'Esc', description: format(messages.close) },
      ],
    },
  ]
})

//endregion

// Open the book once everything about it is known - and once everything this needs is
// declared, since it runs at once: at the page the address names,
// else where the reader left off, else at the beginning.
watch(
  [bookId, book, series, pageDtos],
  () => {
    if (openedBookId.value === bookId.value) return
    if (!book.value || book.value.id !== bookId.value || !pageDtos.value || !series.value) return
    if (series.value.id !== book.value.seriesId) return

    const progress = book.value.readProgress
    page.value =
      clampPage(route.query.page, pageCount.value) ??
      (progress && !progress.completed ? clampPage(progress.page, pageCount.value) : undefined) ??
      1
    sliderPage.value = page.value
    askNextBook.value = false
    askPreviousBook.value = false
    openedBookId.value = bookId.value

    applySeriesDirection()
  },
  { immediate: true },
)

// The reader takes the whole window, without the scroll bar a long page would bring.
onMounted(() => document.documentElement.classList.add('html-reader'))
onBeforeUnmount(() => {
  document.documentElement.classList.remove('html-reader')
  if (isFullscreen.value) void exitFullscreen()
  // What the rest of the application knows about this book - its progress above
  // all - is out of date now.
  if (!incognito.value) clearBook(bookId.value)
})
</script>

<style scoped>
.reader {
  min-height: 100dvh;
}

.bar {
  position: fixed;
  left: 0;
  z-index: 2;
  width: 100%;
}
.bar--top {
  top: 0;
}
.bar--bottom {
  bottom: 0;
}
</style>

<style>
/* The reader scrolls without a scroll bar, and does not pull the page behind it. */
.html-reader {
  scrollbar-width: none;
  overscroll-behavior: none;
}
.html-reader::-webkit-scrollbar {
  display: none;
}
</style>

<route lang="yaml">
meta:
  layout: single
  requiresRole: PAGE_STREAMING
</route>
