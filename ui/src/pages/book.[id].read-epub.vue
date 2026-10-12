<template>
  <div
    class="epub-reader"
    :style="{ backgroundColor: colours.background, color: colours.text }"
  >
    <EmptyStateNetworkError v-if="error" />

    <v-progress-linear
      v-else-if="!ready"
      indeterminate
      color="primary"
    />

    <template v-else>
      <v-toolbar
        v-show="showBars"
        density="compact"
        elevation="1"
        :theme="store.theme === 'dark' ? 'dark' : undefined"
      >
        <v-btn
          icon="i-mdi:arrow-left"
          :aria-label="$formatMessage(messages.close)"
          @click="closeBook()"
        />
        <v-btn
          icon="i-mdi:table-of-contents"
          :aria-label="$formatMessage(messages.contents)"
          :disabled="toc.length === 0"
          @click="showContents = !showContents"
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
          icon="i-mdi:cog"
          :aria-label="$formatMessage(messages.settings)"
          @click="showSettings = !showSettings"
        />
      </v-toolbar>

      <div class="stage">
        <!--
          A chapter is a document out of the book, shown in a frame that may not
          run script: the book is somebody else's file. The page reaches into the
          frame to style it and to listen to it, which the frame being of the same
          origin allows.
        -->
        <iframe
          ref="frame"
          class="chapter"
          :class="{ 'chapter--hidden': !laidOut }"
          :src="chapterUrl"
          :title="title"
          sandbox="allow-same-origin"
          @load="chapterLoaded()"
        />
      </div>

      <div
        v-show="showBars"
        class="status"
      >
        <v-btn
          icon="i-mdi:chevron-left"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.previous)"
          :disabled="atStart"
          @click="previous()"
        />
        <div class="status__text text-body-small">
          <span
            v-if="chapterTitle"
            class="status__chapter"
            >{{ chapterTitle }}</span
          >
          <span v-if="place">{{
            $formatMessage(valueMessages.position, {
              position: place.position,
              total: positions.length,
              percent: percent(place.totalProgression),
            })
          }}</span>
        </div>
        <v-btn
          icon="i-mdi:chevron-right"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.next)"
          :disabled="atEnd"
          @click="next()"
        />
      </div>

      <v-navigation-drawer
        v-model="showContents"
        temporary
        location="start"
        width="320"
      >
        <v-list density="compact">
          <v-list-subheader>{{ $formatMessage(messages.contents) }}</v-list-subheader>
          <v-list-item
            v-for="(entry, index) in toc"
            :key="index"
            :title="entry.title"
            :active="entry.chapter === chapter"
            @click="goToContents(entry)"
          />
        </v-list>
      </v-navigation-drawer>

      <v-bottom-sheet
        v-model="showSettings"
        inset
      >
        <v-card :title="$formatMessage(messages.settings)">
          <v-card-text class="d-flex flex-column ga-4">
            <div>
              <div class="text-label-large mb-1">{{ $formatMessage(messages.theme) }}</div>
              <v-btn-toggle
                v-model="store.theme"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubThemeValues"
                  :key="value"
                  :value="value"
                  :text="$formatMessage(themeMessages[value])"
                />
              </v-btn-toggle>
            </div>

            <div>
              <div class="text-label-large mb-1">{{ $formatMessage(messages.layout) }}</div>
              <v-btn-toggle
                v-model="store.layout"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubLayoutValues"
                  :key="value"
                  :value="value"
                  :text="$formatMessage(layoutMessages[value])"
                />
              </v-btn-toggle>
            </div>

            <div>
              <div class="text-label-large mb-1">{{ $formatMessage(messages.font) }}</div>
              <v-btn-toggle
                v-model="store.font"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubFontValues"
                  :key="value"
                  :value="value"
                  :text="$formatMessage(fontMessages[value])"
                />
              </v-btn-toggle>
            </div>

            <v-slider
              v-model="store.fontSize"
              :label="$formatMessage(messages.fontSize)"
              :min="EPUB_FONT_SIZE.min"
              :max="EPUB_FONT_SIZE.max"
              :step="EPUB_FONT_SIZE.step"
              thumb-label
              hide-details
            />
          </v-card-text>
        </v-card>
      </v-bottom-sheet>
    </template>
  </div>
</template>

<script lang="ts" setup>
/**
 * The EPUB reader.
 *
 * A book of text is a list of chapters, each a document inside the file. One
 * chapter is shown at a time, in a frame, laid out either as pages to turn or as
 * one column to scroll. Where the reader is - which chapter, how far into it - is
 * reported to the server as a Readium locator, which is what lets the book open
 * again at the same place and be marked read at its end.
 *
 * This does what the legacy reader did with a library of its own; the reference's
 * was pinned to a fork on a git address. A chapter needs no more than a frame and
 * a stylesheet, and the book cannot run script either way.
 */
import { useQuery } from '@pinia/colada'
import { useDebounceFn, useEventListener, useFullscreen } from '@vueuse/core'
import { defineMessages, type MessageDescriptor } from 'vue-intl'
import { bookDetailQuery, QUERY_KEYS_BOOKS } from '@/colada/books'
import {
  chapterIndexOf,
  fragmentOf,
  pageAt,
  pageCount,
  percent,
  positionAt,
  progressionOf,
  resourcePath,
  type EpubPosition,
} from '@/functions/epub'
import { EPUB_THEMES, epubStyle } from '@/functions/epub-style'
import {
  komgaGetBookPositions,
  komgaGetBookProgression,
  komgaGetBookWebPubManifest,
  komgaUpdateBookProgression,
} from '@/generated/openapi'
import {
  EPUB_FONT_SIZE,
  EpubFontValues,
  EpubLayoutValues,
  EpubThemeValues,
  useEpubReaderStore,
  type EpubFont,
  type EpubLayout,
  type EpubTheme,
} from '@/stores/epub-reader'

const route = useRoute('/book.[id].read-epub')
const router = useRouter()
const store = useEpubReaderStore()

const bookId = computed(() => route.params.id)
const incognito = computed(() => route.query.incognito === 'true')

//region What the book is

const { data: book, error: bookError } = useQuery(() => bookDetailQuery({ bookId: bookId.value }))

const { data: manifest, error: manifestError } = useQuery(() => ({
  key: [...QUERY_KEYS_BOOKS.byId(bookId.value), 'manifest'],
  query: () => komgaGetBookWebPubManifest({ path: { bookId: bookId.value } }),
}))

const { data: positionList, error: positionsError } = useQuery(() => ({
  key: [...QUERY_KEYS_BOOKS.byId(bookId.value), 'positions'],
  query: () => komgaGetBookPositions({ path: { bookId: bookId.value } }),
}))

// Where the reader left off. It is asked for once per opening and not kept: what
// was true when the book was last closed is not true once a page has been turned.
const { data: savedProgression, status: progressionStatus } = useQuery(() => ({
  key: [...QUERY_KEYS_BOOKS.byId(bookId.value), 'progression', 'open'],
  query: () => komgaGetBookProgression({ path: { bookId: bookId.value } }),
  staleTime: 0,
  gcTime: 0,
}))

const error = computed(() => bookError.value ?? manifestError.value ?? positionsError.value)
const readingOrder = computed(() => manifest.value?.readingOrder ?? [])
const positions = computed<EpubPosition[]>(() => positionList.value?.positions ?? [])
const title = computed(() => book.value?.metadata.title ?? manifest.value?.metadata.title ?? '')

/** The table of contents, each entry knowing which chapter it leads to. */
const toc = computed(() =>
  (manifest.value?.toc ?? [])
    .filter((entry) => entry.href !== undefined)
    .map((entry) => ({
      title: entry.title ?? resourcePath(entry.href ?? ''),
      href: entry.href ?? '',
      chapter: chapterIndexOf(readingOrder.value, entry.href ?? ''),
    }))
    .filter((entry) => entry.chapter !== -1),
)

const ready = computed(
  () =>
    book.value !== undefined &&
    manifest.value !== undefined &&
    positionList.value !== undefined &&
    progressionStatus.value !== 'pending' &&
    readingOrder.value.length > 0,
)

//endregion

//region Where the reader is

/** Which chapter is shown, and where in it to go once it has been laid out. */
const chapter = ref(0)
type Target = { progression: number } | { fragment: string } | 'end'
let target: Target = { progression: 0 }

/** The page shown and how many the chapter has, when it is laid out as pages. */
const page = ref(0)
const pages = ref(1)
/** How far into the chapter the reader is, from 0 to 1. */
const progression = ref(0)
/** Whether the chapter in the frame has been styled and moved to its place. */
const laidOut = ref(false)
let opened = false
/** How far, in pixels, the chapter is moved to the left to show the current page. */
let shift = 0

const frame = useTemplateRef<HTMLIFrameElement>('frame')
const chapterUrl = computed(() => readingOrder.value[chapter.value]?.href)
const chapterPath = computed(() => resourcePath(chapterUrl.value ?? ''))
// The entry that leads to this chapter, or failing that the one before it: a
// chapter the contents do not list belongs to the part it sits in.
const chapterTitle = computed(
  () =>
    (
      toc.value.find((entry) => entry.chapter === chapter.value) ??
      toc.value.findLast((entry) => entry.chapter < chapter.value)
    )?.title,
)

const place = computed(() =>
  positionAt(positions.value, { path: chapterPath.value, progression: progression.value }),
)

const paginated = computed(() => store.layout === 'paginated')
const atStart = computed(() => chapter.value === 0 && (paginated.value ? page.value === 0 : true))
const atEnd = computed(
  () =>
    chapter.value === readingOrder.value.length - 1 &&
    (paginated.value ? page.value === pages.value - 1 : true),
)

// Open the book where it was left, once everything about it is known.
watch(
  ready,
  (isReady) => {
    if (!isReady || opened) return
    opened = true

    const locator = savedProgression.value?.locator
    const index = locator ? chapterIndexOf(readingOrder.value, locator.href) : -1
    if (index !== -1) {
      target = { progression: locator?.locations?.progression ?? 0 }
      chapter.value = index
    }
  },
  { immediate: true },
)

/** Show a chapter, and go to a place in it once it has loaded. */
function showChapter(index: number, to: Target) {
  if (index < 0 || index >= readingOrder.value.length) return
  target = to
  if (index === chapter.value) {
    goToTarget()
    return
  }
  laidOut.value = false
  chapter.value = index
}

//endregion

//region Laying a chapter out

const STYLE_ID = 'mangalibrary-reader-style'

function frameDocument(): Document | null {
  try {
    return frame.value?.contentDocument ?? null
  } catch {
    return null
  }
}

function applyStyle() {
  const document = frameDocument()
  if (!document?.documentElement) return

  let style = document.getElementById(STYLE_ID)
  if (style === null) {
    // The element is made in the chapter's own namespace, or an XHTML document
    // would not treat it as a stylesheet.
    style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style')
    style.id = STYLE_ID
    ;(document.head ?? document.documentElement).append(style)
  }
  style.textContent = epubStyle({
    theme: store.theme,
    layout: store.layout,
    font: store.font,
    fontSize: store.fontSize,
  })
}

/**
 * Put a page of the chapter in the window.
 *
 * The chapter is moved sideways rather than the window scrolled: a window will
 * not scroll past the end of what it holds, and the last column of a chapter ends
 * short of a whole page, so scrolling to it would stop a gutter early.
 */
function showPage(document: Document, window: Window, number: number) {
  shift = number * window.innerWidth
  document.body?.style.setProperty('transform', `translateX(${-shift}px)`)
}

/** How wide the chapter is laid out, in pages or not. */
function contentWidth(document: Document): number {
  return document.body?.scrollWidth ?? document.documentElement.scrollWidth
}

/** Count the chapter's pages again, keeping the reader where they were. */
function measure() {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!window || !document?.documentElement) return

  if (paginated.value) {
    pages.value = pageCount(contentWidth(document), window.innerWidth)
    page.value = pageAt(progression.value, pages.value)
    showPage(document, window, page.value)
  } else {
    pages.value = 1
    page.value = 0
  }
}

function goToTarget() {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!window || !document?.documentElement) return

  const root = document.documentElement
  if (paginated.value) {
    pages.value = pageCount(contentWidth(document), window.innerWidth)
    if (target === 'end') page.value = pages.value - 1
    else if ('fragment' in target) {
      const element = document.getElementById(target.fragment)
      // Where the element is now, plus how far the chapter is already moved.
      const left = element ? element.getBoundingClientRect().left + shift : 0
      page.value = Math.min(Math.max(Math.floor(left / window.innerWidth), 0), pages.value - 1)
    } else page.value = pageAt(target.progression, pages.value)
    showPage(document, window, page.value)
  } else {
    // A chapter that scrolls is not moved sideways.
    shift = 0
    document.body?.style.removeProperty('transform')
    const height = Math.max(root.scrollHeight - window.innerHeight, 0)
    if (target === 'end') window.scrollTo(0, height)
    else if ('fragment' in target) {
      const element = document.getElementById(target.fragment)
      window.scrollTo(0, element ? element.getBoundingClientRect().top + window.scrollY : 0)
    } else window.scrollTo(0, target.progression * height)
  }
  located()
}

/** Work out how far into the chapter the reader now is, and remember it. */
function located() {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!window || !document?.documentElement) return

  if (paginated.value) {
    // The last page shows the chapter's end, and is reported as having reached it:
    // otherwise the end of a book is a place nobody is ever at.
    progression.value =
      page.value >= pages.value - 1 && pages.value > 0 ? 1 : progressionOf(page.value, pages.value)
  } else {
    const height = document.documentElement.scrollHeight - window.innerHeight
    progression.value = height <= 0 ? 1 : Math.min(Math.max(window.scrollY / height, 0), 1)
  }
  void saveProgress()
}

function chapterLoaded() {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!window || !document?.documentElement) return

  // A link the reader followed inside the frame may have taken it elsewhere in
  // the book; the chapter shown is whichever one the frame now holds.
  const landed = chapterIndexOf(readingOrder.value, window.location.href)
  if (landed !== -1 && landed !== chapter.value) {
    target = { progression: 0 }
    chapter.value = landed
  }

  // A chapter that has just loaded has not been moved anywhere yet.
  shift = 0
  applyStyle()
  listen(document, window)

  // Lay out now, and again when the pictures and fonts that move the text arrive.
  const settle = () => {
    goToTarget()
    laidOut.value = true
  }
  settle()
  for (const image of document.querySelectorAll('img')) {
    if (!image.complete) image.addEventListener('load', () => measure(), { once: true })
  }
  void document.fonts?.ready.then(() => measure())
}

function listen(document: Document, window: Window) {
  document.addEventListener('keydown', (event) => handleKey(event))
  document.addEventListener('click', (event) => handleClick(event, window))
  window.addEventListener('scroll', () => {
    if (!paginated.value) located()
  })
}

// A change of setting lays the same chapter out again, at the same place.
watch(
  () => [store.theme, store.layout, store.font, store.fontSize] as const,
  () => {
    if (!laidOut.value) return
    target = { progression: progression.value }
    applyStyle()
    // The new layout is not measurable until the browser has done it.
    requestAnimationFrame(() => goToTarget())
  },
)

const measureSoon = useDebounceFn(() => {
  if (laidOut.value) measure()
}, 150)
useEventListener(window, 'resize', () => void measureSoon())

//endregion

//region Moving

function next() {
  if (paginated.value && page.value < pages.value - 1) {
    turnTo(page.value + 1)
  } else if (chapter.value < readingOrder.value.length - 1) {
    showChapter(chapter.value + 1, { progression: 0 })
  } else if (!paginated.value) {
    scrollByPage(1)
  }
}

function previous() {
  if (paginated.value && page.value > 0) {
    turnTo(page.value - 1)
  } else if (chapter.value > 0) {
    showChapter(chapter.value - 1, 'end')
  } else if (!paginated.value) {
    scrollByPage(-1)
  }
}

function turnTo(newPage: number) {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!window || !document) return
  page.value = newPage
  showPage(document, window, newPage)
  located()
}

/** In a scrolled chapter, a "page" is most of a window. */
function scrollByPage(direction: 1 | -1) {
  const window = frame.value?.contentWindow
  window?.scrollBy({ top: direction * window.innerHeight * 0.9, behavior: 'smooth' })
}

/** Forward or back the way a key or a click at the edge means it. */
function step(direction: 1 | -1) {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (!paginated.value && window && document) {
    // A scrolled chapter scrolls until it runs out, and only then changes chapter.
    const height = document.documentElement.scrollHeight - window.innerHeight
    const canScroll = direction === 1 ? window.scrollY < height - 2 : window.scrollY > 2
    if (canScroll) return scrollByPage(direction)
  }
  if (direction === 1) next()
  else previous()
}

function goToContents(entry: { href: string; chapter: number }) {
  showContents.value = false
  const fragment = fragmentOf(entry.href)
  showChapter(entry.chapter, fragment === undefined ? { progression: 0 } : { fragment })
}

function closeBook() {
  void router.push({ name: '/book/[id]', params: { id: bookId.value } })
}

/** A click in the chapter: a link is followed, an edge turns the page, the middle shows the bars. */
function handleClick(event: MouseEvent, window: Window) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (anchor) {
    event.preventDefault()
    const index = chapterIndexOf(readingOrder.value, anchor.href)
    const fragment = fragmentOf(anchor.href)
    if (index !== -1) showChapter(index, fragment === undefined ? { progression: 0 } : { fragment })
    // Anything else leaves the book, and does so in a tab of its own.
    else if (/^https?:/i.test(anchor.href)) globalThis.open(anchor.href, '_blank', 'noopener')
    return
  }

  // Selecting text ends in a click too, and is not a request to turn the page.
  if ((window.getSelection()?.toString() ?? '') !== '') return

  const at = event.clientX / window.innerWidth
  if (at < 0.25) step(-1)
  else if (at > 0.75) step(1)
  else showBars.value = !showBars.value
}

const keys: Record<string, () => void> = {
  ArrowRight: () => step(1),
  ArrowLeft: () => step(-1),
  PageDown: () => step(1),
  PageUp: () => step(-1),
  ' ': () => step(1),
  Home: () => showChapter(0, { progression: 0 }),
  End: () => showChapter(readingOrder.value.length - 1, 'end'),
  c: () => (showContents.value = !showContents.value),
  s: () => (showSettings.value = !showSettings.value),
  f: () => void toggleFullscreen(),
  m: () => (showBars.value = !showBars.value),
  Escape: () => {
    if (showSettings.value) showSettings.value = false
    else if (showContents.value) showContents.value = false
    else closeBook()
  },
}

function handleKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const action = keys[event.key]
  if (!action) return
  event.preventDefault()
  action()
}

// Keys pressed while the chapter has the focus are heard inside the frame; these
// are the ones pressed anywhere else.
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  const element = event.target as HTMLElement | null
  if (element?.closest?.('input, textarea, [role="slider"], .v-overlay')) return
  handleKey(event)
})

//endregion

//region Remembering

if (store.deviceId === '') store.deviceId = crypto.randomUUID()

const saveProgress = useDebounceFn(() => {
  if (incognito.value || !laidOut.value) return
  const found = place.value
  void komgaUpdateBookProgression({
    path: { bookId: bookId.value },
    body: {
      modified: new Date(),
      device: { id: store.deviceId, name: 'Manga Library web reader' },
      locator: {
        href: chapterPath.value,
        type: readingOrder.value[chapter.value]?.type ?? 'application/xhtml+xml',
        ...(chapterTitle.value ? { title: chapterTitle.value } : {}),
        locations: {
          fragments: [],
          progression: progression.value,
          ...(found ? { position: found.position, totalProgression: found.totalProgression } : {}),
        },
      },
    },
  }).catch(() => {
    // A place that could not be saved is saved at the next page turn.
  })
}, 600)

//endregion

//region The frame around it

const showBars = ref(true)
const showContents = ref(false)
const showSettings = ref(false)
const colours = computed(() => EPUB_THEMES[store.theme])

const { isSupported: fullscreenSupported, isFullscreen, toggle: toggleFullscreen } = useFullscreen()

const messages = defineMessages({
  close: {
    description: 'EPUB reader: button that closes the reader',
    defaultMessage: 'Close the reader',
    id: 'Lo4Bni',
  },
  contents: {
    description: 'EPUB reader: table of contents button and heading',
    defaultMessage: 'Table of contents',
    id: 'UlOj+a',
  },
  settings: {
    description: 'EPUB reader: settings button and heading',
    defaultMessage: 'Reader settings',
    id: 'a8blbg',
  },
  fullscreen: {
    description: 'EPUB reader: full screen button',
    defaultMessage: 'Full screen',
    id: 'cA6T9s',
  },
  incognito: {
    description: 'EPUB reader: tooltip of the icon shown when progress is not recorded',
    defaultMessage: 'Reading without recording progress',
    id: 'YK/9vX',
  },
  previous: {
    description: 'EPUB reader: previous page button',
    defaultMessage: 'Previous page',
    id: '3w4CBv',
  },
  next: {
    description: 'EPUB reader: next page button',
    defaultMessage: 'Next page',
    id: 'aqD5OX',
  },
  theme: {
    description: 'EPUB reader settings: colour theme',
    defaultMessage: 'Theme',
    id: '4k3t1s',
  },
  layout: {
    description: 'EPUB reader settings: paginated or scrolled',
    defaultMessage: 'Layout',
    id: 'n7w50d',
  },
  font: {
    description: 'EPUB reader settings: typeface',
    defaultMessage: 'Font',
    id: '0P3HV6',
  },
  fontSize: {
    description: 'EPUB reader settings: text size',
    defaultMessage: 'Text size',
    id: 'WU2K0J',
  },
})

const valueMessages: Record<'position', MessageDescriptor> = defineMessages({
  position: {
    description: 'EPUB reader: where the reader is in the book',
    defaultMessage: '{position} of {total} · {percent}%',
    id: 'tZ4VEB',
  },
})

const themeMessages: Record<EpubTheme, MessageDescriptor> = defineMessages({
  light: {
    description: 'EPUB reader theme: light',
    defaultMessage: 'Light',
    id: 'h+jwbD',
  },
  sepia: {
    description: 'EPUB reader theme: sepia',
    defaultMessage: 'Sepia',
    id: 'oI2295',
  },
  dark: {
    description: 'EPUB reader theme: dark',
    defaultMessage: 'Dark',
    id: '1Emdn+',
  },
})

const layoutMessages: Record<EpubLayout, MessageDescriptor> = defineMessages({
  paginated: {
    description: 'EPUB reader layout: pages to turn',
    defaultMessage: 'Pages',
    id: 'SsHQdR',
  },
  scrolled: {
    description: 'EPUB reader layout: one column to scroll',
    defaultMessage: 'Scroll',
    id: 'W9tEnJ',
  },
})

const fontMessages: Record<EpubFont, MessageDescriptor> = defineMessages({
  publisher: {
    description: "EPUB reader font: the book's own",
    defaultMessage: "Book's own",
    id: 'hQDs+b',
  },
  serif: {
    description: 'EPUB reader font: serif',
    defaultMessage: 'Serif',
    id: 'PtVpqD',
  },
  sans: {
    description: 'EPUB reader font: sans-serif',
    defaultMessage: 'Sans-serif',
    id: 'gXahuU',
  },
})

//endregion
</script>

<style scoped>
.epub-reader {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  justify-content: center;
}

.chapter {
  border: 0;
  width: 100%;
  max-width: 820px;
  height: 100%;
}

/* Hidden while it is being laid out, so the reader never sees a chapter jump to its place. */
.chapter--hidden {
  visibility: hidden;
}

.status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  opacity: 0.85;
}

.status__text {
  display: flex;
  gap: 12px;
  min-width: 0;
}

.status__chapter {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<route lang="yaml">
meta:
  layout: single
  requiresRole: PAGE_STREAMING
</route>
