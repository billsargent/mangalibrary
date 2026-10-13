<template>
  <v-container
    fluid
    class="pa-2 pa-sm-4"
  >
    <v-skeleton-loader
      v-if="isPending"
      type="card@3"
    />

    <EmptyStateNetworkError v-else-if="error" />

    <template v-else-if="data">
      <div class="d-flex align-center mb-2">
        <h2 class="text-title-large">{{ $formatMessage(messages.libraries) }}</h2>
        <v-spacer />
        <v-btn
          icon="i-mdi:refresh"
          variant="text"
          :loading="isLoading"
          :aria-label="$formatMessage(commonMessages.mediaPageRefresh)"
          @click="refetch()"
        />
      </div>

      <v-row dense>
        <v-col
          v-for="tile in tiles"
          :key="tile.label"
          cols="6"
          sm="4"
          lg="2"
        >
          <v-card class="h-100">
            <v-card-text>
              <div class="text-medium-emphasis text-truncate">{{ tile.label }}</div>
              <div class="text-headline-small">{{ tile.value }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row dense>
        <v-col
          v-for="chart in libraryCharts"
          :key="chart.title"
          cols="12"
          md="6"
          xl="3"
        >
          <MetricsBars
            :title="chart.title"
            :bars="chart.bars"
            :format="chart.format"
            :empty="$formatMessage(messages.noLibrary)"
          />
        </v-col>
      </v-row>

      <h2 class="text-title-large mt-6 mb-1">{{ $formatMessage(messages.tasks) }}</h2>
      <p class="text-medium-emphasis mb-2">{{ $formatMessage(messages.tasksSince) }}</p>

      <v-row dense>
        <v-col
          cols="12"
          md="6"
        >
          <MetricsBars
            :title="$formatMessage(messages.tasksCount)"
            :total="wholeNumber(statisticOf(data.tasksCount.metric, 'COUNT') ?? 0)"
            :bars="metricBars(data.tasksCount.byTag)"
            :format="wholeNumber"
            :empty="$formatMessage(messages.noTask)"
          />
        </v-col>
        <v-col
          cols="12"
          md="6"
        >
          <MetricsBars
            :title="$formatMessage(messages.tasksTime)"
            :total="seconds(statisticOf(data.tasksTime.metric, 'TOTAL_TIME') ?? 0)"
            :bars="metricBars(data.tasksTime.byTag)"
            :format="seconds"
            :empty="$formatMessage(messages.noTask)"
          />
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>

<script lang="ts" setup>
import { defineMessage, useIntl } from 'vue-intl'
import { useMetrics } from '@/colada/metrics'
import { useLibraries } from '@/colada/libraries'
import { getFileSize } from '@/functions/filesize'
import { metricBars, statisticOf } from '@/functions/metrics'
import { commonMessages } from '@/utils/i18n/common-messages'

const intl = useIntl()

const { data, error, isPending, isLoading, refetch } = useMetrics()
const { data: libraries } = useLibraries()

// A library that was removed while the page was open keeps its id for a name.
const libraryName = (id: string) =>
  libraries.value?.find((library) => library.id === id)?.name ?? id

const wholeNumber = (value: number) => intl.formatNumber(value)
const fileSize = (value: number) => getFileSize(value) ?? wholeNumber(0)
const seconds = (value: number) =>
  intl.formatNumber(value, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    maximumFractionDigits: value < 10 ? 1 : 0,
  })

const tiles = computed(() => {
  if (!data.value) return []
  const value = data.value
  return [
    {
      label: intl.formatMessage(messages.series),
      value: wholeNumber(statisticOf(value.series.metric, 'VALUE') ?? 0),
    },
    {
      label: intl.formatMessage(messages.books),
      value: wholeNumber(statisticOf(value.books.metric, 'VALUE') ?? 0),
    },
    {
      label: intl.formatMessage(messages.fileSize),
      value: fileSize(statisticOf(value.fileSize.metric, 'VALUE') ?? 0),
    },
    {
      label: intl.formatMessage(messages.sidecars),
      value: wholeNumber(statisticOf(value.sidecars.metric, 'VALUE') ?? 0),
    },
    {
      label: intl.formatMessage(messages.collections),
      value: wholeNumber(statisticOf(value.collections, 'VALUE') ?? 0),
    },
    {
      label: intl.formatMessage(messages.readLists),
      value: wholeNumber(statisticOf(value.readLists, 'VALUE') ?? 0),
    },
  ]
})

const libraryCharts = computed(() => {
  if (!data.value) return []
  const value = data.value
  return [
    {
      title: intl.formatMessage(messages.books),
      bars: metricBars(value.books.byTag, libraryName),
      format: wholeNumber,
    },
    {
      title: intl.formatMessage(messages.series),
      bars: metricBars(value.series.byTag, libraryName),
      format: wholeNumber,
    },
    {
      title: intl.formatMessage(messages.fileSize),
      bars: metricBars(value.fileSize.byTag, libraryName),
      format: fileSize,
    },
    {
      title: intl.formatMessage(messages.sidecars),
      bars: metricBars(value.sidecars.byTag, libraryName),
      format: wholeNumber,
    },
  ]
})

const messages = {
  libraries: defineMessage({
    description: 'Metrics page: heading of the section about what the libraries hold',
    defaultMessage: 'Libraries',
    id: 'HO+yGb',
  }),
  series: defineMessage({
    description: 'Metrics page: number of series',
    defaultMessage: 'Series',
    id: 'eQP+TQ',
  }),
  books: defineMessage({
    description: 'Metrics page: number of books',
    defaultMessage: 'Books',
    id: '6CgcQc',
  }),
  fileSize: defineMessage({
    description: 'Metrics page: total size of book files on disk',
    defaultMessage: 'Disk space',
    id: '4fiwhi',
  }),
  sidecars: defineMessage({
    description: 'Metrics page: number of cover image files found beside books and series',
    defaultMessage: 'Cover files',
    id: 'EjsPUB',
  }),
  collections: defineMessage({
    description: 'Metrics page: number of collections',
    defaultMessage: 'Collections',
    id: 'Heh/9C',
  }),
  readLists: defineMessage({
    description: 'Metrics page: number of read lists',
    defaultMessage: 'Read lists',
    id: 'AsI+jT',
  }),
  noLibrary: defineMessage({
    description: 'Metrics page: shown in a per-library chart when the server has no library',
    defaultMessage: 'No library yet',
    id: 'y+lImT',
  }),
  tasks: defineMessage({
    description: 'Metrics page: heading of the section about background tasks',
    defaultMessage: 'Tasks',
    id: 'yo9gG5',
  }),
  tasksSince: defineMessage({
    description: 'Metrics page: explains that task figures restart with the server',
    defaultMessage: 'Counted since the server last started.',
    id: 'EQ5RFX',
  }),
  tasksCount: defineMessage({
    description: 'Metrics page: chart of how many tasks of each type ran',
    defaultMessage: 'Tasks executed',
    id: '641OVa',
  }),
  tasksTime: defineMessage({
    description: 'Metrics page: chart of the time spent on each type of task',
    defaultMessage: 'Tasks total time',
    id: 'fLSbYJ',
  }),
  noTask: defineMessage({
    description: 'Metrics page: shown in a task chart when no task has run',
    defaultMessage: 'Nothing has run yet',
    id: 'aAmYxz',
  }),
}
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
