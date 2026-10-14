<template>
  <div class="search-box">
    <v-text-field
      v-model="text"
      :placeholder="$formatMessage(messages.placeholder)"
      :aria-label="$formatMessage(messages.placeholder)"
      prepend-inner-icon="i-mdi:magnify"
      variant="solo-filled"
      density="compact"
      flat
      hide-details
      clearable
      single-line
      autocomplete="off"
      @keydown.enter="search()"
      @keydown.esc="open = false"
      @focus="focused = true"
      @blur="leave()"
      @click:prepend-inner="search()"
    />

    <v-menu
      v-model="open"
      activator="parent"
      location="bottom start"
      :open-on-click="false"
      :close-on-content-click="true"
      max-height="420"
    >
      <v-list
        density="compact"
        class="search-suggestions"
      >
        <template v-if="suggestedSeries.length > 0">
          <v-list-subheader>{{ $formatMessage(messages.series) }}</v-list-subheader>
          <v-list-item
            v-for="item in suggestedSeries"
            :key="item.id"
            :title="item.metadata.title"
            :subtitle="$formatMessage(valueMessages.booksCount, { count: item.booksCount })"
            :to="{ name: '/series/[id]', params: { id: item.id } }"
          />
        </template>
        <template v-if="suggestedBooks.length > 0">
          <v-list-subheader>{{ $formatMessage(messages.books) }}</v-list-subheader>
          <v-list-item
            v-for="item in suggestedBooks"
            :key="item.id"
            :title="item.metadata.title"
            :subtitle="item.seriesTitle"
            :to="{ name: '/book/[id]', params: { id: item.id } }"
          />
        </template>
        <v-list-item
          :title="$formatMessage(valueMessages.allResults, { term: debounced })"
          prepend-icon="i-mdi:magnify"
          @click="search()"
        />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
/**
 * The search box of the app bar.
 *
 * Pressing Enter goes to the search page with what was typed in the address. On
 * that page the box shows what the address says, so a reloaded or shared search
 * still reads back what it is a search for.
 *
 * While typing, a few series and books that match are offered under the box - the
 * best five of each - so that something known can be opened without the results
 * page. Asked for only after a pause, and only for two characters or more.
 */
import { useQuery } from '@pinia/colada'
import { refDebounced } from '@vueuse/core'
import { defineMessages, type MessageDescriptor } from 'vue-intl'
import { bookListQuery } from '@/colada/books'
import { seriesListQuery } from '@/colada/series'
import { searchRoute, searchTerm } from '@/functions/search'
import { PageRequest } from '@/types/PageRequest'

const route = useRoute()
const router = useRouter()

const text = ref('')
const focused = ref(false)
const open = ref(false)

watch(
  () => [route.name, route.query.q] as const,
  ([name, query]) => {
    if (name === '/search') text.value = searchTerm(query)
  },
  { immediate: true },
)

const debounced = refDebounced(
  computed(() => (text.value ?? '').trim()),
  300,
)
const asking = computed(() => focused.value && debounced.value.length >= 2)
const firstFive = new PageRequest(0, 5)

const { data: seriesFound } = useQuery(() => ({
  ...seriesListQuery({ search: { fullTextSearch: debounced.value }, pageRequest: firstFive }),
  enabled: asking.value,
}))
const { data: booksFound } = useQuery(() => ({
  ...bookListQuery({ search: { fullTextSearch: debounced.value }, pageRequest: firstFive }),
  enabled: asking.value,
}))
const suggestedSeries = computed(() => (asking.value ? (seriesFound.value?.content ?? []) : []))
const suggestedBooks = computed(() => (asking.value ? (booksFound.value?.content ?? []) : []))

// Offered when there is something to offer, and the box is being typed in.
watch([suggestedSeries, suggestedBooks, asking], () => {
  open.value = asking.value && suggestedSeries.value.length + suggestedBooks.value.length > 0
})

/** Leaving the box closes the offer, after a click in it has had time to land. */
function leave() {
  setTimeout(() => {
    focused.value = false
  }, 200)
}

function search() {
  open.value = false
  const to = searchRoute(text.value ?? '')
  if (to !== null) void router.push(to)
}

const messages = defineMessages({
  placeholder: {
    description: 'App bar search box: placeholder',
    defaultMessage: 'Search',
    id: 'ZCBxIm',
  },
  series: {
    description: 'App bar search box: heading of the series offered while typing',
    defaultMessage: 'Series',
    id: 'yltosv',
  },
  books: {
    description: 'App bar search box: heading of the books offered while typing',
    defaultMessage: 'Books',
    id: 'pPYhpn',
  },
})

// Messages with values in them are typed apart, as the formatter needs.
const valueMessages: Record<'booksCount' | 'allResults', MessageDescriptor> = defineMessages({
  booksCount: {
    description: 'App bar search box: how many books a series offered while typing has',
    defaultMessage: '{count, plural, one {# book} other {# books}}',
    id: 'URRCbG',
  },
  allResults: {
    description: 'App bar search box: the last choice, which opens every result',
    defaultMessage: 'All results for "{term}"',
    id: 'VWMRsE',
  },
})
</script>

<style scoped>
.search-box {
  max-width: 420px;
  min-width: 140px;
  width: 100%;
}
</style>
