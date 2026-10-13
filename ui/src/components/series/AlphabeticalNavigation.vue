<template>
  <nav
    :aria-label="$formatMessage(messages.label)"
    class="alphabetical-navigation d-flex justify-sm-center px-2 py-1"
  >
    <v-btn
      v-for="symbol in symbols"
      :key="symbol"
      :text="symbol === SYMBOL_ALL ? $formatMessage(messages.all) : symbol"
      :variant="symbol === modelValue ? 'tonal' : 'text'"
      :color="symbol === modelValue ? 'primary' : undefined"
      :disabled="isEmpty(symbol)"
      :title="counts ? $formatMessage(messages.count, { count: counts[symbol] ?? 0 }) : undefined"
      :aria-current="symbol === modelValue ? 'true' : undefined"
      size="small"
      min-width="32"
      class="px-1 flex-shrink-0 text-none"
      @click="emit('update:modelValue', symbol)"
    />
  </nav>
</template>

<script setup lang="ts">
import { defineMessage, type MessageDescriptor } from 'vue-intl'
import { SYMBOL_ALL } from '@/functions/alphabetical'

/**
 * A row of symbols to jump to the series whose title begins with one of them.
 */
const { modelValue, counts } = defineProps<{
  /** The symbols to offer, in order. */
  symbols: string[]
  /** The symbol in effect. */
  modelValue: string
  /** How many series each symbol leads to. A symbol that leads to none cannot be chosen. */
  counts?: Record<string, number>
}>()

const emit = defineEmits<{
  'update:modelValue': [symbol: string]
}>()

// The symbol in effect stays enabled even when it leads nowhere, so it can be left.
function isEmpty(symbol: string): boolean {
  return !!counts && symbol !== modelValue && symbol !== SYMBOL_ALL && (counts[symbol] ?? 0) === 0
}

const messages: Record<'label' | 'count' | 'all', MessageDescriptor> = {
  label: defineMessage({
    description: 'Alphabetical navigation: accessible name of the row of letters',
    defaultMessage: 'Series by first character',
    id: 'xCwovb',
  }),
  count: defineMessage({
    description: 'Alphabetical navigation: how many series a letter leads to, shown on hover',
    defaultMessage: '{count, plural, one {# series} other {# series}}',
    id: '+MhEDM',
  }),
  all: defineMessage({
    description: 'Alphabetical navigation: the choice that shows every series',
    defaultMessage: 'All',
    id: 'NYbVbN',
  }),
}
</script>

<style scoped>
/* On a narrow screen the row is swiped sideways instead of stacking into a block of letters. */
.alphabetical-navigation {
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: thin;
}

@media (min-width: 600px) {
  .alphabetical-navigation {
    flex-wrap: wrap;
    overflow-x: visible;
  }
}
</style>
