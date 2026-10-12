<template>
  <div
    ref="root"
    class="paged-reader"
  >
    <div
      v-if="currentSpread"
      :key="spreadIndex"
      class="spread"
      :class="[
        `spread--${scaleClass}`,
        {
          'spread--double': isDouble,
          'spread--reverse': flipDirection,
          'spread--animate-from-right': animations && arrivesFrom > 0,
          'spread--animate-from-left': animations && arrivesFrom < 0,
        },
      ]"
    >
      <div
        v-for="(item, i) in currentSpread"
        :key="`${spreadIndex}-${i}`"
        class="half"
      >
        <img
          v-if="!item.blank"
          :src="item.url"
          :alt="
            $formatMessage(
              {
                description: 'Reader: alternative text of a page image',
                defaultMessage: 'Page {number}',
                id: '7xthj+',
              },
              { number: item.number },
            )
          "
          draggable="false"
        />
      </div>
    </div>

    <!-- The spreads around the current one, fetched ahead so that a turn does not wait. -->
    <div
      class="preload"
      aria-hidden="true"
    >
      <img
        v-for="url in preloadUrls"
        :key="url"
        :src="url"
        alt=""
      />
    </div>

    <template v-if="vertical">
      <div
        class="zone zone--top"
        @click="prev()"
      />
      <div
        class="zone zone--bottom"
        @click="next()"
      />
      <div
        class="zone zone--middle"
        @click="emit('menu')"
      />
    </template>
    <template v-else>
      <div
        class="zone zone--left"
        @click="turnLeft()"
      />
      <div
        class="zone zone--right"
        @click="turnRight()"
      />
      <div
        class="zone zone--center"
        @click="emit('menu')"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useEventListener, useSwipe } from '@vueuse/core'
import { buildSpreads, pageOfSpread, spreadIndexOf } from '@/functions/book-spreads'
import type { ReadingDirection } from '@/types/ReadingDirection'
import type { PageLayout, ReaderPage, ScaleType } from '@/types/reader'

/**
 * The reader that shows one page, or one pair of pages, at a time.
 *
 * It owns nothing but which spread is on screen: the page number is the parent's,
 * and turning past either end of the book is reported for the parent to decide what
 * comes next.
 */
const {
  pages,
  readingDirection,
  pageLayout,
  scale,
  animations,
  swipe,
  disabled = false,
} = defineProps<{
  pages: ReaderPage[]
  readingDirection: ReadingDirection
  pageLayout: PageLayout
  scale: ScaleType
  animations: boolean
  swipe: boolean
  /** Set while a dialog is open over the reader, so keys meant for it do not turn pages. */
  disabled?: boolean
}>()

const page = defineModel<number>('page', { required: true })

const emit = defineEmits<{
  menu: []
  jumpPrevious: []
  jumpNext: []
}>()

const spreads = computed(() => buildSpreads(pages, pageLayout))
const spreadIndex = computed(() => spreadIndexOf(spreads.value, page.value))
const currentSpread = computed(() => spreads.value[spreadIndex.value])

const isDouble = computed(
  () => pageLayout !== 'SINGLE_PAGE' && (currentSpread.value?.length ?? 0) > 1,
)
const flipDirection = computed(() => readingDirection === 'RIGHT_TO_LEFT')
const vertical = computed(() => readingDirection === 'VERTICAL')
const scaleClass = computed(() => scale.toLowerCase().replaceAll('_', '-'))

const preloadUrls = computed(() => {
  const urls: string[] = []
  for (const offset of [1, 2, -1]) {
    for (const item of spreads.value[spreadIndex.value + offset] ?? []) {
      if (!item.blank) urls.push(item.url)
    }
  }
  return urls
})

/** Which way the last turn went: forward or back through the book. */
const lastMove = ref(0)
/** The side of the window the new page arrives from, which is the other one when reading right to left. */
const arrivesFrom = computed(() => (flipDirection.value ? -lastMove.value : lastMove.value))

function show(index: number) {
  const spread = spreads.value[index]
  if (!spread) return
  lastMove.value = Math.sign(index - spreadIndex.value)
  page.value = pageOfSpread(spread)
  window.scrollTo(0, 0)
}

function prev() {
  if (spreadIndex.value > 0) show(spreadIndex.value - 1)
  else emit('jumpPrevious')
}

function next() {
  if (spreadIndex.value < spreads.value.length - 1) show(spreadIndex.value + 1)
  else emit('jumpNext')
}

// Left and right mean the side of the screen. Which of them is "next" is the
// reading direction's business.
function turnLeft() {
  if (vertical.value) return
  if (flipDirection.value) next()
  else prev()
}

function turnRight() {
  if (vertical.value) return
  if (flipDirection.value) prev()
  else next()
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (disabled || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
  switch (event.key) {
    case 'ArrowLeft':
      turnLeft()
      break
    case 'ArrowRight':
      turnRight()
      break
    case 'ArrowUp':
      if (vertical.value) prev()
      break
    case 'ArrowDown':
      if (vertical.value) next()
      break
    case 'PageUp':
      prev()
      break
    case 'PageDown':
    case ' ':
      next()
      break
    default:
      return
  }
  event.preventDefault()
})

const root = useTemplateRef('root')
useSwipe(root, {
  onSwipeEnd(_event, direction) {
    if (!swipe || disabled) return
    // The page follows the finger: dragging it away to the left shows what was on the right.
    if (direction === 'left') turnRight()
    else if (direction === 'right') turnLeft()
    else if (direction === 'up' && vertical.value) next()
    else if (direction === 'down' && vertical.value) prev()
  },
})
</script>

<style scoped>
.paged-reader {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100dvh;
}

.spread {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
}

.spread--reverse {
  flex-direction: row-reverse;
}

.half {
  display: flex;
  justify-content: center;
}

img {
  display: block;
  object-fit: contain;
  user-select: none;
}

/* Two pages meet in the middle of the window, like a book lying open. */
.spread--double .half {
  width: 50vw;
}
.spread--double:not(.spread--reverse) .half:first-child,
.spread--double.spread--reverse .half:last-child {
  justify-content: flex-end;
}
.spread--double:not(.spread--reverse) .half:last-child,
.spread--double.spread--reverse .half:first-child {
  justify-content: flex-start;
}
.spread--double:not(.spread--reverse) .half:first-child img,
.spread--double.spread--reverse .half:last-child img {
  object-position: right center;
}
.spread--double:not(.spread--reverse) .half:last-child img,
.spread--double.spread--reverse .half:first-child img {
  object-position: left center;
}

/* Fit to screen: the whole page is visible, as large as it can be. */
.spread--screen img {
  width: 100vw;
  height: 100dvh;
}
.spread--screen.spread--double img {
  width: auto;
  max-width: 100%;
}

/* Fit to width: the page is as wide as the window and scrolls down. */
.spread--width {
  align-items: flex-start;
}
.spread--width img {
  width: 100vw;
}
.spread--width.spread--double img {
  width: 100%;
}

.spread--width-shrink-only {
  align-items: flex-start;
}
.spread--width-shrink-only img {
  max-width: 100vw;
}
.spread--width-shrink-only.spread--double img {
  max-width: 100%;
}

/* Fit to height: the page is as tall as the window, however wide that makes it. */
.spread--height img {
  height: 100dvh;
}

.spread--original img {
  width: auto;
  height: auto;
}

.spread--animate-from-right {
  animation: page-in-from-right 0.18s ease-out;
}
.spread--animate-from-left {
  animation: page-in-from-left 0.18s ease-out;
}
@keyframes page-in-from-right {
  from {
    opacity: 0.3;
    transform: translateX(3%);
  }
}
@keyframes page-in-from-left {
  from {
    opacity: 0.3;
    transform: translateX(-3%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spread--animate-from-right,
  .spread--animate-from-left {
    animation: none;
  }
}

.preload {
  position: fixed;
  width: 0;
  height: 0;
  overflow: hidden;
  visibility: hidden;
}

/* The window is divided into what a click on it does. */
.zone {
  position: fixed;
  z-index: 1;
}
.zone--left {
  top: 0;
  left: 0;
  width: 25%;
  height: 100%;
}
.zone--right {
  top: 0;
  right: 0;
  width: 25%;
  height: 100%;
}
.zone--center {
  top: 0;
  left: 25%;
  width: 50%;
  height: 100%;
}
.zone--top {
  top: 0;
  left: 0;
  width: 100%;
  height: 25%;
}
.zone--bottom {
  bottom: 0;
  left: 0;
  width: 100%;
  height: 25%;
}
.zone--middle {
  top: 25%;
  left: 0;
  width: 100%;
  height: 50%;
}
</style>
