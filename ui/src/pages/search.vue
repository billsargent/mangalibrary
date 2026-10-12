<template>
  <div class="pa-4 d-flex flex-column ga-6">
    <div
      v-if="term !== ''"
      class="text-title-large"
    >
      {{ $formatMessage(valueMessages.resultsFor, { term }) }}
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
              stretch-poster
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
              stretch-poster
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
              stretch-poster
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
              stretch-poster
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
import { defineMessages, type MessageDescriptor } from 'vue-intl'
import { useDisplay } from 'vuetify'
import { bookListQueryInfinite } from '@/colada/books'
import { collectionsListQueryInfinite } from '@/colada/collections'
import { readListsListQueryInfinite } from '@/colada/readlists'
import { seriesListQueryInfinite } from '@/colada/series'
import { searchTerm } from '@/functions/search'
import type { BookDto, CollectionDto, ReadListDto, SeriesDto } from '@/generated/openapi'
import { useAppStore } from '@/stores/app'

const route = useRoute('/search')
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

// A search term orders by relevance unless told otherwise, so no sort is given.
const series = results<SeriesDto>(() =>
  seriesListQueryInfinite({ search: { fullTextSearch: term.value } }),
)
const books = results<BookDto>(() =>
  bookListQueryInfinite({ search: { fullTextSearch: term.value } }),
)
const collections = results<CollectionDto>(() =>
  collectionsListQueryInfinite({ search: term.value }),
)
const readLists = results<ReadListDto>(() => readListsListQueryInfinite({ search: term.value }))

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
