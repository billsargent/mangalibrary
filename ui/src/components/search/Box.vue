<template>
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
    class="search-box"
    @keydown.enter="search()"
    @click:prepend-inner="search()"
  />
</template>

<script setup lang="ts">
/**
 * The search box of the app bar.
 *
 * Pressing Enter goes to the search page with what was typed in the address. On
 * that page the box shows what the address says, so a reloaded or shared search
 * still reads back what it is a search for.
 */
import { defineMessages } from 'vue-intl'
import { searchRoute, searchTerm } from '@/functions/search'

const route = useRoute()
const router = useRouter()

const text = ref('')

watch(
  () => [route.name, route.query.q] as const,
  ([name, query]) => {
    if (name === '/search') text.value = searchTerm(query)
  },
  { immediate: true },
)

function search() {
  const to = searchRoute(text.value ?? '')
  if (to !== null) void router.push(to)
}

const messages = defineMessages({
  placeholder: {
    description: 'App bar search box: placeholder',
    defaultMessage: 'Search',
    id: 'ZCBxIm',
  },
})
</script>

<style scoped>
.search-box {
  max-width: 420px;
  min-width: 140px;
}
</style>
