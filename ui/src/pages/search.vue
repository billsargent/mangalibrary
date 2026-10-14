<template>
  <v-app-bar
    v-if="term !== ''"
    class="bg-background px-2"
  >
    <template #append>
      <PosterSizeSlider />
    </template>
  </v-app-bar>

  <div class="pa-4 d-flex flex-column ga-6">
    <div
      v-if="term !== ''"
      class="text-title-large"
    >
      {{ $formatMessage(valueMessages.resultsFor, { term }) }}
    </div>

    <div
      v-if="term !== ''"
      class="d-flex flex-wrap ga-3"
    >
      <v-select
        v-model="library"
        :items="libraryItems"
        :label="$formatMessage(messages.library)"
        density="compact"
        hide-details
        max-width="260"
      />
      <v-select
        v-model="readStatus"
        :items="readStatusItems"
        :label="$formatMessage(messages.readStatus)"
        density="compact"
        hide-details
        max-width="220"
      />
      <v-select
        v-model="seriesSort"
        :items="seriesSortItems"
        :label="$formatMessage(messages.seriesSort)"
        density="compact"
        hide-details
        max-width="240"
      />
      <v-select
        v-model="booksSort"
        :items="booksSortItems"
        :label="$formatMessage(messages.booksSort)"
        density="compact"
        hide-details
        max-width="240"
      />
    </div>

    <v-empty-state
      v-if="term === ''"
      icon="i-mdi:magnify"
      :title="$formatMessage(messages.nothingAsked)"
      :text="$formatMessage(messages.nothingAskedText)"
    />

    <template v-else>
      <ItemScroller
        v-if="series.items.value.length > 0"
        :items="series.items.value"
        :title="$formatMessage(messages.series)"
        :has-next-page="series.hasNextPage.value"
        class="with-gap"
        @load-next-page="series.loadNextPage()"
      >
        <template #default="{ item }">
          <div class="py-2 px-1">
            <SeriesCard
              :series="item as SeriesDto"
              :width="cardWidth"
            />
          </div>
        </template>
      </ItemScroller>

      <ItemScroller
        v-if="books.items.value.length > 0"
        :items="books.items.value"
        :title="$formatMessage(messages.books)"
        :has-next-page="books.hasNextPage.value"
        class="with-gap"
        @load-next-page="books.loadNextPage()"
      >
        <template #default="{ item }">
          <div class="py-2 px-1">
            <BookCard
              :book="item as BookDto"
              show-series
              :width="cardWidth"
            />
          </div>
        </template>
      </ItemScroller>

      <ItemScroller
        v-if="collections.items.value.length > 0"
        :items="collections.items.value"
        :title="$formatMessage(messages.collections)"
        :has-next-page="collections.hasNextPage.value"
        class="with-gap"
        @load-next-page="collections.loadNextPage()"
      >
        <template #default="{ item }">
          <div class="py-2 px-1">
            <CollectionCard
              :collection="item as CollectionDto"
              :width="cardWidth"
            />
          </div>
        </template>
      </ItemScroller>

      <ItemScroller
        v-if="readLists.items.value.length > 0"
        :items="readLists.items.value"
        :title="$formatMessage(messages.readLists)"
        :has-next-page="readLists.hasNextPage.value"
        class="with-gap"
        @load-next-page="readLists.loadNextPage()"
      >
        <template #default="{ item }">
          <div class="py-2 px-1">
            <ReadlistCard
              :read-list="item as ReadListDto"
              :width="cardWidth"
            />
          </div>
        </template>
      </ItemScroller>

      <div
        v-if="searching"
        class="d-flex justify-center"
      >
        <v-progress-circular indeterminate />
      </div>

      <v-empty-state
        v-else-if="nothingFound"
        icon="i-mdi:magnify"
        :title="$formatMessage(messages.noResults)"
        :text="$formatMessage(messages.noResultsText)"
      />
    </template>
  </div>
</template>

<script lang="ts" setup>
/**
 * Search across everything the library holds.
 *
 * This is the legacy search page: one row each for the series, books, collections
 * and read lists that match, most relevant first. What is searched for lives in the
 * address, so a result page can be reloaded, bookmarked and sent to somebody.
 */
import { useInfiniteQuery } from '@pinia/colada'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
import PosterSizeSlider from '@/components/PosterSizeSlider.vue'
import { useLibraries } from '@/colada/libraries'
import { sortBooks, sortSeries } from '@/types/sort'
import type { Sort } from '@/types/PageRequest'
import { useDisplay } from 'vuetify'
import { bookListQueryInfinite } from '@/colada/books'
import { collectionsListQueryInfinite } from '@/colada/collections'
import { readListsListQueryInfinite } from '@/colada/readlists'
import { seriesListQueryInfinite } from '@/colada/series'
import { searchTerm } from '@/functions/search'
import type { BookDto, CollectionDto, ReadListDto, SeriesDto } from '@/generated/openapi'
import { useAppStore } from '@/stores/app'

const route = useRoute('/search')
const router = useRouter()
const intl = useIntl()
const display = useDisplay()
const appStore = useAppStore()

const term = computed(() => searchTerm(route.query.q))
const cardWidth = computed(() => (display.smAndUp.value ? appStore.gridCardWidth : 130))

/** One kind of result: its items so far, and how to ask for more. */
function results<T>(options: () => unknown) {
  const { data, hasNextPage, loadNextPage, isPending } = useInfiniteQuery(
    () =>
      ({
        ...(options() as object),
        // Nothing is asked of the server until there is something to search for.
        enabled: term.value !== '',
      }) as never,
  ) as unknown as {
    data: Ref<{ pages: ({ content?: T[]; totalElements?: number } | undefined)[] } | undefined>
    hasNextPage: Ref<boolean>
    loadNextPage: () => void
    isPending: Ref<boolean>
  }

  return {
    items: computed(() => data.value?.pages.flatMap((page) => page?.content ?? []) ?? []),
    hasNextPage,
    loadNextPage,
    isPending,
  }
}

/*
 * What narrows and orders the results lives in the address beside the term, so a
 * narrowed search can be reloaded and shared like any other.
 */
const ANY = 'any'
const RELEVANCE = 'relevance'
const queryText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback
const fromQuery = (name: 'library' | 'read' | 'seriesSort' | 'booksSort', fallback: string) =>
  computed({
    get: () => queryText(route.query[name], fallback),
    set: (value: string) =>
      void router.replace({
        query: { ...route.query, [name]: value === fallback ? undefined : value },
      }),
  })
const library = fromQuery('library', ANY)
const readStatus = fromQuery('read', ANY)
const seriesSort = fromQuery('seriesSort', RELEVANCE)
const booksSort = fromQuery('booksSort', RELEVANCE)

const { data: libraries } = useLibraries()
const libraryItems = computed(() => [
  { title: intl.formatMessage(messages.allLibraries), value: ANY },
  ...(libraries.value ?? []).map((entry) => ({ title: entry.name, value: entry.id })),
])
const readStatusItems = computed(() => [
  { title: intl.formatMessage(messages.anyReadStatus), value: ANY },
  { title: intl.formatMessage(messages.unread), value: 'UNREAD' },
  { title: intl.formatMessage(messages.inProgress), value: 'IN_PROGRESS' },
  { title: intl.formatMessage(messages.read), value: 'READ' },
])

/** The sorts a kind of result can take: relevance, then the listings' own, each way. */
function sortItems(
  options: readonly { key: string; message: MessageDescriptor; invertible?: boolean }[],
) {
  return [
    { title: intl.formatMessage(messages.relevance), value: RELEVANCE },
    ...options
      .filter((option) => option.key !== 'random')
      .flatMap((option) => [
        { title: `${intl.formatMessage(option.message)} ↑`, value: `${option.key},asc` },
        ...(option.invertible
          ? [{ title: `${intl.formatMessage(option.message)} ↓`, value: `${option.key},desc` }]
          : []),
      ]),
  ]
}
const seriesSortItems = computed(() => sortItems(sortSeries))
const booksSortItems = computed(() => sortItems(sortBooks))

/** No sort is relevance: a search term orders by it unless told otherwise. */
const sortOf = (value: string): Sort[] | undefined => {
  if (value === RELEVANCE) return undefined
  const [key, order] = value.split(',')
  return [{ key: key!, order: order === 'desc' ? 'desc' : 'asc' }]
}

/** The narrowing both series and books take: a library, and how far the reader has got. */
const condition = computed(() => {
  const allOf: object[] = []
  if (library.value !== ANY) allOf.push({ libraryId: { operator: 'is', value: library.value } })
  if (readStatus.value !== ANY)
    allOf.push({ readStatus: { operator: 'is', value: readStatus.value } })
  return allOf.length === 0 ? undefined : { allOf }
})
const libraryIds = computed(() => (library.value === ANY ? undefined : [library.value]))

const series = results<SeriesDto>(() =>
  seriesListQueryInfinite({
    search: { fullTextSearch: term.value, condition: condition.value } as never,
    sort: sortOf(seriesSort.value),
  }),
)
const books = results<BookDto>(() =>
  bookListQueryInfinite({
    search: { fullTextSearch: term.value, condition: condition.value } as never,
    sort: sortOf(booksSort.value),
  }),
)
// Collections and read lists have no read status, but they are in libraries.
const collections = results<CollectionDto>(() =>
  collectionsListQueryInfinite({ search: term.value, libraryIds: libraryIds.value }),
)
const readLists = results<ReadListDto>(() =>
  readListsListQueryInfinite({ search: term.value, libraryIds: libraryIds.value }),
)

const all = [series, books, collections, readLists]
const searching = computed(() => all.some((kind) => kind.isPending.value))
const nothingFound = computed(() => all.every((kind) => kind.items.value.length === 0))

const messages = defineMessages({
  nothingAsked: {
    description: 'Search page: title shown before anything has been searched for',
    defaultMessage: 'Search your libraries',
    id: 'uNhlA4',
  },
  nothingAskedText: {
    description: 'Search page: text shown before anything has been searched for',
    defaultMessage:
      'Type in the search box above to find series, books, collections and read lists.',
    id: 'FtrCl4',
  },
  noResults: {
    description: 'Search page: title when a search finds nothing',
    defaultMessage: 'No results',
    id: 'GVd3lj',
  },
  noResultsText: {
    description: 'Search page: text when a search finds nothing',
    defaultMessage: 'Try searching for something else',
    id: '+qv7R9',
  },
  series: {
    description: 'Search page: heading of the series that match',
    defaultMessage: 'Series',
    id: 'AXB/RI',
  },
  books: {
    description: 'Search page: heading of the books that match',
    defaultMessage: 'Books',
    id: 'cGE5EN',
  },
  collections: {
    description: 'Search page: heading of the collections that match',
    defaultMessage: 'Collections',
    id: 'wwJ0BM',
  },
  readLists: {
    description: 'Search page: heading of the read lists that match',
    defaultMessage: 'Read lists',
    id: 'ELbS/T',
  },
  library: {
    description: 'Search page: label of the library filter',
    defaultMessage: 'Library',
    id: '0HQ8Yq',
  },
  allLibraries: {
    description: 'Search page: the library filter choice that searches every library',
    defaultMessage: 'All libraries',
    id: '4nmlVr',
  },
  readStatus: {
    description: 'Search page: label of the read status filter',
    defaultMessage: 'Read status',
    id: 'gLaEaD',
  },
  anyReadStatus: {
    description: 'Search page: the read status filter choice that keeps everything',
    defaultMessage: 'Any',
    id: 'Ia2u4L',
  },
  unread: {
    description: 'Search page: read status filter choice',
    defaultMessage: 'Unread',
    id: 'z4V0fT',
  },
  inProgress: {
    description: 'Search page: read status filter choice',
    defaultMessage: 'In progress',
    id: 'VuVpcn',
  },
  read: {
    description: 'Search page: read status filter choice',
    defaultMessage: 'Read',
    id: '3qH+Nl',
  },
  seriesSort: {
    description: 'Search page: label of the order the series are listed in',
    defaultMessage: 'Order series by',
    id: 'cE+8r6',
  },
  booksSort: {
    description: 'Search page: label of the order the books are listed in',
    defaultMessage: 'Order books by',
    id: 'r0WTKl',
  },
  relevance: {
    description: 'Search page: the order that puts the best matches first',
    defaultMessage: 'Relevance',
    id: 'MFpe/e',
  },
})

const valueMessages: Record<'resultsFor', MessageDescriptor> = defineMessages({
  resultsFor: {
    description: 'Search page: title naming what was searched for',
    defaultMessage: 'Search results for "{term}"',
    id: 'f5M08C',
  },
})
</script>

<style scoped>
.with-gap :deep(.v-slide-group__content) {
  gap: 8px;
}
</style>
