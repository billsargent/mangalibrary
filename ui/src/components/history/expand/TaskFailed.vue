<template>
  <HistoryExpandTable :rows="rows" />
</template>

<script setup lang="ts">
import type { HistoricalEventDto } from '@/generated/openapi'

/** A background task the server gave up on, after trying it more than once. */
const { event } = defineProps<{
  event: HistoricalEventDto
}>()

const rows = computed(() =>
  [
    { header: 'Task', value: event.properties.task },
    { header: 'Reason', value: event.properties.reason },
    { header: 'Attempts', value: event.properties.attempts },
    { header: 'Library', value: event.properties.library },
  ].filter((row) => row.value !== undefined),
)
</script>
