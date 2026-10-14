<template>
  <v-container
    fluid
    class="pa-4 d-flex flex-column ga-4"
  >
    <div class="d-flex flex-wrap align-center ga-4">
      <div class="text-title-large">{{ $formatMessage(messages.title) }}</div>
      <v-select
        v-model="library"
        :items="libraryItems"
        :label="$formatMessage(messages.library)"
        density="compact"
        hide-details
        max-width="320"
      />
    </div>

    <SeriesAlphabeticalNavigation
      v-if="letters.length > 0"
      :model-value="letter"
      :symbols="letters"
      :counts="letterCounts"
      @update:model-value="(symbol: string) => (letter = symbol)"
    />

    <v-progress-linear
      v-if="isPending"
      indeterminate
    />

    <v-empty-state
      v-else-if="tags.length === 0"
      icon="i-mdi:tag-off-outline"
      :title="$formatMessage(messages.none)"
    />

    <div
      v-else
      class="tag-cloud"
      :aria-label="$formatMessage(messages.cloudLabel, { letter: letter.toUpperCase() })"
    >
      <RouterLink
        v-for="entry in shown"
        :key="entry.tag"
        :to="linkTo(entry.tag)"
        class="tag-cloud__tag"
        :style="{ fontSize: `${TAG_SIZES[tagSize(entry.count, largest)]}rem` }"
      >
        {{ entry.tag }} <span class="tag-cloud__count">({{ entry.count }})</span>
      </RouterLink>
    </div>
  </v-container>
</template>

<script lang="ts" setup>
/**
 * Every tag, a letter at a time, each followed by how many series it leads to and
 * drawn larger the more there are. Choosing one opens the series list filtered by it.
 *
 * The library and the letter live in the address, so the page can be reloaded,
 * bookmarked and reached from elsewhere.
 */
import { useQuery } from '@pinia/colada'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
import { useLibraries } from '@/colada/libraries'
import { tagCloudQuery } from '@/colada/tag-cloud'
import { filterToQuery } from '@/functions/filter'
import { cloudLetters, TAG_SIZES, tagSize } from '@/functions/tag-cloud'

const ALL = 'all'

const intl = useIntl()
const route = useRoute('/tags')
const router = useRouter()

const queryText = (value: unknown): string => (typeof value === 'string' ? value : '')

const library = computed({
  get: () => queryText(route.query.library) || ALL,
  set: (value: string) =>
    void router.replace({
      query: { ...route.query, library: value === ALL ? undefined : value, letter: undefined },
    }),
})

const { data: libraries } = useLibraries()
const libraryItems = computed(() => [
  { title: intl.formatMessage(messages.allLibraries), value: ALL },
  ...(libraries.value ?? []).map((entry) => ({ title: entry.name, value: entry.id })),
])

const { data, isPending } = useQuery(() =>
  tagCloudQuery({ libraryId: library.value === ALL ? undefined : library.value }),
)
const tags = computed(() => data.value ?? [])
const largest = computed(() => tags.value.reduce((most, entry) => Math.max(most, entry.count), 0))

const lettered = computed(() => cloudLetters(tags.value))
const letters = computed(() => lettered.value.letters)
const letterCounts = computed(() => lettered.value.counts)

// The letter asked for if it has tags, else the first that does.
const letter = computed({
  get: () => {
    const asked = queryText(route.query.letter)
    return letters.value.includes(asked) ? asked : (letters.value[0] ?? '')
  },
  set: (value: string) => void router.replace({ query: { ...route.query, letter: value } }),
})

const shown = computed(() => tags.value.filter((entry) => entry.letter === letter.value))

function linkTo(tag: string) {
  return {
    path: `/libraries/${library.value}/series`,
    query: filterToQuery('tag', { m: 'anyOf', v: [{ v: tag }] }),
  }
}

const messages: Record<
  'title' | 'library' | 'allLibraries' | 'none' | 'cloudLabel',
  MessageDescriptor
> = defineMessages({
  title: {
    description: 'Tag cloud page: heading',
    defaultMessage: 'Tags',
    id: '0iKBbr',
  },
  library: {
    description: 'Tag cloud page: label of the library selector',
    defaultMessage: 'Library',
    id: '80TdU6',
  },
  allLibraries: {
    description: 'Tag cloud page: the library selector choice that shows every library',
    defaultMessage: 'All libraries',
    id: 'Q4U1js',
  },
  none: {
    description: 'Tag cloud page: shown when no series has a tag',
    defaultMessage: 'No tags yet',
    id: '/4lyfY',
  },
  cloudLabel: {
    description: 'Tag cloud page: accessible name of the tags of one letter',
    defaultMessage: 'Tags beginning with {letter}',
    id: 'VBzAEk',
  },
})
</script>

<style scoped>
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 1.25rem;
  row-gap: 0.5rem;
  line-height: 1.2;
}

.tag-cloud__tag {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}

.tag-cloud__tag:hover {
  text-decoration: underline;
}

.tag-cloud__count {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
