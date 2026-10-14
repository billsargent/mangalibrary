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
          icon="i-mdi:help-circle"
          :aria-label="$formatMessage(messages.help)"
          @click="showHelp = !showHelp"
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
          :class="{ 'chapter--hidden': !laidOut, 'chapter--spread': paginated && columns === 2 }"
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
          icon="i-mdi:undo"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.previousBook)"
          :disabled="!previousBook"
          @click="goToPreviousBook()"
        />
        <v-btn
          icon="i-mdi:chevron-left"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.previous)"
          :disabled="atStart && !previousBook"
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
          @click="next()"
        />
        <v-btn
          icon="i-mdi:redo"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.nextBook)"
          :disabled="!nextBook"
          @click="goToNextBook()"
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
            :active="index === currentEntry"
            :style="{ paddingInlineStart: `${16 + entry.depth * 16}px` }"
            @click="goToContents(entry)"
          />
        </v-list>
      </v-navigation-drawer>

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
        <p>{{ $formatMessage(messages.atStart) }}</p>
        <p v-if="previousBook">{{ $formatMessage(messages.againForPrevious) }}</p>
      </v-snackbar>

      <v-snackbar
        v-model="askNextBook"
        :timeout="JUMP_CONFIRMATION_MS"
        location="top"
        multi-line
      >
        <p>{{ $formatMessage(messages.atEnd) }}</p>
        <p v-if="nextBook">{{ $formatMessage(messages.againForNext) }}</p>
        <p v-else>{{ $formatMessage(messages.againToLeave) }}</p>
      </v-snackbar>

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

            <div v-if="paginated">
              <div class="text-label-large mb-1">{{ $formatMessage(messages.spread) }}</div>
              <v-btn-toggle
                v-model="store.spread"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubSpreadValues"
                  :key="value"
                  :value="value"
                  :text="$formatMessage(spreadMessages[value])"
                />
              </v-btn-toggle>
            </div>

            <div>
              <div class="text-label-large mb-1">{{ $formatMessage(messages.margins) }}</div>
              <v-btn-toggle
                v-model="store.margins"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubMarginValues"
                  :key="value"
                  :value="value"
                  :text="$formatMessage(marginMessages[value])"
                />
              </v-btn-toggle>
            </div>

            <div>
              <div class="text-label-large mb-1">{{ $formatMessage(messages.lineHeight) }}</div>
              <v-btn-toggle
                v-model="store.lineHeight"
                mandatory
                density="comfortable"
                variant="outlined"
                divided
              >
                <v-btn
                  v-for="value in EpubLineHeightValues"
                  :key="value"
                  :value="value"
                  :text="value === 0 ? $formatMessage(fontMessages.publisher) : String(value)"
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
import type { ShortcutGroup } from '@/components/reader/ShortcutsHelp.vue'
import type { ReaderContext } from '@/types/reader'
import { useDebounceFn, useEventListener, useFullscreen, useWindowSize } from '@vueuse/core'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
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
import { EPUB_THEMES, epubStyle, wideEnoughForTwo } from '@/functions/epub-style'
import {
  type BookDto,
  komgaGetBookPositions,
  komgaGetBookProgression,
  komgaGetBookSiblingNext,
  komgaGetBookSiblingNextInReadList,
  komgaGetBookSiblingPrevious,
  komgaGetBookSiblingPreviousInReadList,
  komgaGetBookWebPubManifest,
  komgaUpdateBookProgression,
} from '@/generated/openapi'
import {
  EPUB_FONT_SIZE,
  EpubFontValues,
  EpubLayoutValues,
  EpubLineHeightValues,
  EpubMarginValues,
  EpubSpreadValues,
  EpubThemeValues,
  useEpubReaderStore,
  type EpubFont,
  type EpubLayout,
  type EpubMargins,
  type EpubSpread,
  type EpubTheme,
} from '@/stores/epub-reader'

const route = useRoute('/book.[id].read-epub')
const router = useRouter()
const store = useEpubReaderStore()
const intl = useIntl()

const bookId = computed(() => route.params.id)
const incognito = computed(() => route.query.incognito === 'true')

/** A book opened from a read list goes on to the next book of that list, not of its series. */
const context = computed<ReaderContext>(() => {
  const id = route.query.contextId
  if (route.query.context === 'READLIST' && typeof id === 'string' && id !== '')
    return { origin: 'READLIST', id }
  return undefined
})

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

type TocLink = { title?: string; href?: string; children?: TocLink[] }

/**
 * The table of contents as one list, each entry knowing which chapter it leads to
 * and how deep it sits: a part's chapters are listed under it, indented.
 */
const toc = computed(() => {
  const entries: { title: string; href: string; chapter: number; depth: number }[] = []
  const add = (links: TocLink[], depth: number) => {
    for (const link of links) {
      const chapter = link.href === undefined ? -1 : chapterIndexOf(readingOrder.value, link.href)
      if (chapter !== -1)
        entries.push({
          title: link.title ?? resourcePath(link.href ?? ''),
          href: link.href ?? '',
          chapter,
          depth,
        })
      add(link.children ?? [], chapter === -1 ? depth : depth + 1)
    }
  }
  add(manifest.value?.toc ?? [], 0)
  return entries
})

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
const currentEntry = computed(() => {
  const exact = toc.value.findIndex((entry) => entry.chapter === chapter.value)
  return exact !== -1 ? exact : toc.value.findLastIndex((entry) => entry.chapter < chapter.value)
})
const chapterTitle = computed(() => toc.value[currentEntry.value]?.title)

const place = computed(() =>
  positionAt(positions.value, { path: chapterPath.value, progression: progression.value }),
)

const paginated = computed(() => store.layout === 'paginated')

/** Two pages side by side when asked for, or when left to choose and the window is wide. */
const windowSize = useWindowSize()
const columns = computed<1 | 2>(() => {
  if (store.spread === 'double') return 2
  if (store.spread === 'single') return 1
  return wideEnoughForTwo(windowSize.width.value, windowSize.height.value) ? 2 : 1
})
const atStart = computed(() => chapter.value === 0 && (paginated.value ? page.value === 0 : true))

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

// Going on to another book keeps this page and changes its address: the new book
// opens where it was left, as this one did.
watch(bookId, () => {
  opened = false
  laidOut.value = false
  target = { progression: 0 }
  chapter.value = 0
  page.value = 0
  askNextBook.value = false
  askPreviousBook.value = false
})

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
    columns: columns.value,
    margins: store.margins,
    lineHeight: store.lineHeight,
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
  () =>
    [
      store.theme,
      store.layout,
      store.font,
      store.fontSize,
      columns.value,
      store.margins,
      store.lineHeight,
    ] as const,
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
  } else if (canScroll(1)) {
    scrollByPage(1)
  } else {
    jumpToNext()
  }
}

function previous() {
  if (paginated.value && page.value > 0) {
    turnTo(page.value - 1)
  } else if (chapter.value > 0) {
    showChapter(chapter.value - 1, 'end')
  } else if (canScroll(-1)) {
    scrollByPage(-1)
  } else {
    jumpToPrevious()
  }
}

/** Whether a scrolled chapter has further to go that way. */
function canScroll(direction: 1 | -1) {
  const window = frame.value?.contentWindow
  const document = frameDocument()
  if (paginated.value || !window || !document) return false
  const height = document.documentElement.scrollHeight - window.innerHeight
  return direction === 1 ? window.scrollY < height - 2 : window.scrollY > 2
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
  // A scrolled chapter scrolls until it runs out, and only then changes chapter.
  if (canScroll(direction)) return scrollByPage(direction)
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

//endregion

//region Moving between books

/** How long the offer to go on to another book stands, as in the comic reader. */
const JUMP_CONFIRMATION_MS = 3000
const askNextBook = ref(false)
const askPreviousBook = ref(false)

/** A book is read in the reader made for it, and in the same read list. */
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
  h: () => (showHelp.value = !showHelp.value),
  '?': () => (showHelp.value = !showHelp.value),
  Escape: () => {
    if (showHelp.value) showHelp.value = false
    else if (showSettings.value) showSettings.value = false
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
const showHelp = ref(false)
const colours = computed(() => EPUB_THEMES[store.theme])

const { isSupported: fullscreenSupported, isFullscreen, toggle: toggleFullscreen } = useFullscreen()

/** What the keys do, for the help the reader shows on H or ?. */
const shortcutGroups = computed<ShortcutGroup[]>(() => {
  const format = intl.formatMessage
  return [
    {
      title: format(messages.groupNavigation),
      shortcuts: [
        { keys: '← PageUp', description: format(messages.previous) },
        { keys: '→ PageDown Space', description: format(messages.next) },
        { keys: 'Home', description: format(messages.keyStart) },
        { keys: 'End', description: format(messages.keyEnd) },
      ],
    },
    {
      title: format(messages.groupReader),
      shortcuts: [
        { keys: 'C', description: format(messages.contents) },
        { keys: 'S', description: format(messages.settings) },
        { keys: 'F', description: format(messages.fullscreen) },
        { keys: 'M', description: format(messages.keyBars) },
        { keys: 'H ?', description: format(messages.help) },
        { keys: 'Esc', description: format(messages.close) },
      ],
    },
  ]
})

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
  previousBook: {
    description: 'EPUB reader: button that opens the previous book',
    defaultMessage: 'Previous book',
    id: '3/MRao',
  },
  nextBook: {
    description: 'EPUB reader: button that opens the next book',
    defaultMessage: 'Next book',
    id: 'EFtOqC',
  },
  help: {
    description: 'EPUB reader: button and key that show the keyboard shortcuts',
    defaultMessage: 'Keyboard shortcuts',
    id: 'xjnAdn',
  },
  atStart: {
    description: 'EPUB reader: shown when going back from the start of the book',
    defaultMessage: 'You are at the beginning of the book.',
    id: 'RHkyzl',
  },
  againForPrevious: {
    description: 'EPUB reader: how to go to the previous book',
    defaultMessage: 'Click or press previous again to move to the previous book.',
    id: 'aSEdGB',
  },
  atEnd: {
    description: 'EPUB reader: shown when going forward from the end of the book',
    defaultMessage: 'You have reached the end of the book.',
    id: 'P+BDaF',
  },
  againForNext: {
    description: 'EPUB reader: how to go to the next book',
    defaultMessage: 'Click or press next again to move to the next book.',
    id: 'tzbGrj',
  },
  againToLeave: {
    description: 'EPUB reader: how to leave after the last book',
    defaultMessage: 'Click or press next again to exit the reader.',
    id: 'BxIGQ2',
  },
  groupNavigation: {
    description: 'EPUB reader keyboard shortcuts: heading of the keys that move through the book',
    defaultMessage: 'Navigation',
    id: 'MLEhSf',
  },
  groupReader: {
    description: 'EPUB reader keyboard shortcuts: heading of the keys that work the reader',
    defaultMessage: 'Reader',
    id: 'UN2wPm',
  },
  keyStart: {
    description: 'EPUB reader keyboard shortcuts: go to the start of the book',
    defaultMessage: 'Start of the book',
    id: 'DpmZ6w',
  },
  keyEnd: {
    description: 'EPUB reader keyboard shortcuts: go to the end of the book',
    defaultMessage: 'End of the book',
    id: 'trtpFp',
  },
  keyBars: {
    description: 'EPUB reader keyboard shortcuts: show or hide the bars',
    defaultMessage: 'Show or hide the bars',
    id: '+71c26',
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
  spread: {
    description: 'EPUB reader settings: how many pages are shown at once',
    defaultMessage: 'Pages side by side',
    id: 'Drky16',
  },
  margins: {
    description: 'EPUB reader settings: space at the sides of the text',
    defaultMessage: 'Margins',
    id: 'egpxJ/',
  },
  lineHeight: {
    description: 'EPUB reader settings: space between lines',
    defaultMessage: 'Line spacing',
    id: 'o0dO+H',
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

const spreadMessages: Record<EpubSpread, MessageDescriptor> = defineMessages({
  auto: {
    description: 'EPUB reader pages: two side by side when the window is wide enough',
    defaultMessage: 'Automatic',
    id: '51vncs',
  },
  single: {
    description: 'EPUB reader pages: one at a time',
    defaultMessage: 'One',
    id: 'EzS8jc',
  },
  double: {
    description: 'EPUB reader pages: two side by side',
    defaultMessage: 'Two',
    id: 'wMv5xR',
  },
})

const marginMessages: Record<EpubMargins, MessageDescriptor> = defineMessages({
  narrow: {
    description: 'EPUB reader margins: narrow',
    defaultMessage: 'Narrow',
    id: 'Zlrbsh',
  },
  normal: {
    description: 'EPUB reader margins: normal',
    defaultMessage: 'Normal',
    id: '+x0NgM',
  },
  wide: {
    description: 'EPUB reader margins: wide',
    defaultMessage: 'Wide',
    id: 'u0Z3t1',
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

/* Two pages side by side, each as wide as one alone. */
.chapter--spread {
  max-width: 1640px;
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
