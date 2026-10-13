<template>
  <v-card class="h-100">
    <v-card-title class="d-flex align-baseline ga-2">
      <span class="text-truncate">{{ title }}</span>
      <v-spacer />
      <span
        v-if="total !== undefined"
        class="text-body-medium text-medium-emphasis flex-shrink-0"
        >{{ total }}</span
      >
    </v-card-title>

    <v-card-text>
      <div
        v-if="bars.length === 0"
        class="text-medium-emphasis"
      >
        {{ empty }}
      </div>

      <div
        v-for="bar in bars"
        :key="bar.key"
        class="mb-3"
      >
        <div class="d-flex ga-2 mb-1">
          <span class="text-truncate">{{ bar.label }}</span>
          <v-spacer />
          <span class="flex-shrink-0">{{ format(bar.value) }}</span>
        </div>
        <v-progress-linear
          :model-value="bar.percent"
          :aria-label="bar.label"
          color="primary"
          height="8"
          rounded
        />
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { MetricBar } from '@/functions/metrics'

/**
 * A titled list of horizontal bars, which is all the charting the metrics page needs.
 */
defineProps<{
  title: string
  /** Shown beside the title, already formatted. */
  total?: string
  bars: MetricBar[]
  /** Said in place of the bars when there are none. */
  empty: string
  format: (value: number) => string
}>()
</script>
