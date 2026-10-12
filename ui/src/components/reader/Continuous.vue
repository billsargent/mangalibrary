<template>
  <div>
    <div class="strip">
      <img
        v-for="(item, i) in pages"
        :id="`page${item.number}`"
        :key="item.number"
        ref="images"
        :data-page="item.number"
        :src="shouldLoad(i) ? item.url : undefined"
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
        :width="widthOf(item)"
        :height="heightOf(item)"
        :style="{ marginTop: i === 0 ? 0 : `${pageMargin}px` }"
        :class="{ unsized: heightOf(item) === undefined }"
        draggable="false"
      />
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { useEventListener, useThrottleFn, useWindowSize } from '@vueuse/core'
import type { ContinuousScaleType, ReaderPage } from '@/types/reader'

/**
 * The reader that lays every page out in one long strip, for books drawn to be
 * scrolled: webtoons.
 *
 * The window itself scrolls. Which page is "the current one" follows what comes
 * into view, and an image is only asked for when the reader is near it.
 */
const {
  pages,
  scale,
  sidePadding,
  pageMargin,
  animations,
  disabled = false,
} = defineProps<{
  pages: ReaderPage[]
  scale: ContinuousScaleType
  /** Percentage of the window left empty on each side. */
  sidePadding: number
  /** Pixels between two pages. */
  pageMargin: number
  animations: boolean
  /** Set while a dialog is open over the reader. */
  disabled?: boolean
}>()

const page = defineModel<number>('page', { required: true })

const emit = defineEmits<{
  menu: []
  jumpPrevious: []
  jumpNext: []
}>()

const { width: windowWidth, height: windowHeight } = useWindowSize()

/** The page that last came into view, which is not always the one the parent asked for. */
const seenPage = ref(1)
const seen = ref(new Set<number>())

function shouldLoad(index: number): boolean {
  return index === 0 || seen.value.has(index + 1) || Math.abs(seenPage.value - 1 - index) <= 2
}

const fittedWidth = computed(() => windowWidth.value - (windowWidth.value * sidePadding * 2) / 100)

function widthOf(item: ReaderPage): number | undefined {
  if (scale === 'WIDTH') return fittedWidth.value
  return item.width
}

function heightOf(item: ReaderPage): number | undefined {
  if (scale === 'WIDTH') {
    if (item.width && item.height) return item.height * (fittedWidth.value / item.width)
    return undefined
  }
  return item.height
}

const images = useTemplateRef<HTMLImageElement[]>('images')
let observer: IntersectionObserver | undefined

function observe() {
  observer?.disconnect()
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const number = Number((entry.target as HTMLElement).dataset.page)
      seen.value.add(number)
      seenPage.value = number
      page.value = number
    }
  })
  for (const image of images.value ?? []) observer.observe(image)
}

function scrollToPage(number: number) {
  document.getElementById(`page${number}`)?.scrollIntoView({ behavior: 'instant', block: 'start' })
}

onMounted(() => {
  observe()
  if (page.value !== seenPage.value) scrollToPage(page.value)
})
onBeforeUnmount(() => observer?.disconnect())

watch(
  () => pages,
  async () => {
    seen.value = new Set()
    await nextTick()
    observe()
    if (page.value === 1) window.scrollTo(0, 0)
    else scrollToPage(page.value)
  },
)

// The parent moved the page - the slider, the thumbnails, Home or End - rather than
// the scroll that reports it.
watch(page, (number) => {
  if (number !== seenPage.value) scrollToPage(number)
})

function canPrev(): boolean {
  return window.scrollY > 0
}

function canNext(): boolean {
  return window.scrollY + windowHeight.value < document.documentElement.scrollHeight - 1
}

function scrollBy(screens: number) {
  window.scrollBy({
    top: windowHeight.value * screens,
    behavior: animations ? 'smooth' : 'instant',
  })
}

function prev() {
  if (canPrev()) scrollBy(-0.95)
  else emit('jumpPrevious')
}

function next() {
  if (canNext()) scrollBy(0.95)
  else emit('jumpNext')
}

// The browser scrolls on these keys by itself. All that is left to do is notice a
// key pressed where there is nowhere further to scroll - and a key held down must
// not count as asking twice.
const atAnEnd = useThrottleFn((key: string) => {
  if ([' ', 'PageDown', 'ArrowDown'].includes(key) && !canNext()) emit('jumpNext')
  else if (['PageUp', 'ArrowUp'].includes(key) && !canPrev()) emit('jumpPrevious')
}, 500)

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (disabled || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
  void atAnEnd(event.key)
})
</script>

<style scoped>
.strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100dvh;
}

img {
  display: block;
  max-width: none;
  user-select: none;
}

/* A page whose size is not known yet still needs room to scroll into. */
.unsized:not([src]) {
  min-height: 60dvh;
}

.zone {
  position: fixed;
  left: 0;
  z-index: 1;
  width: 100%;
}
.zone--top {
  top: 0;
  height: 25dvh;
}
.zone--bottom {
  top: 75dvh;
  height: 25dvh;
}
.zone--middle {
  top: 25dvh;
  height: 50dvh;
}
</style>
