<template>
  <v-container
    fluid
    class="pa-0 pa-sm-4 h-100 h-sm-auto"
  >
    <v-data-table-server
      v-model:sort-by="sortBy"
      :loading="isLoading"
      :items="search === null ? [] : data?.content"
      :items-length="search === null ? 0 : (data?.totalElements ?? 0)"
      :items-per-page-options="[20, 50, 100]"
      :items-per-page="20"
      :headers="headers"
      fixed-header
      fixed-footer
      multi-sort
      mobile-breakpoint="md"
      style="height: 100%"
      @update:options="updateOptions"
    >
      <template #top>
        <v-toolbar flat>
          <v-toolbar-title>
            <v-icon
              color="medium-emphasis"
              icon="i-mdi:file-alert-outline"
              size="x-small"
              start
            />
            {{ $formatMessage(messages.title) }}
          </v-toolbar-title>
          <v-btn
            icon="i-mdi:refresh"
            :aria-label="$formatMessage(commonMessages.mediaPageRefresh)"
            @click="refetch()"
          />
        </v-toolbar>

        <div class="d-flex flex-wrap align-center ga-4 pa-4">
          <v-chip-group
            v-model="statuses"
            multiple
            mandatory
            color="primary"
          >
            <v-chip
              v-for="status in ANALYSIS_STATUSES"
              :key="status"
              :value="status"
              :text="$formatMessage(mediaStatusMessages[status])"
              filter
            />
          </v-chip-group>

          <v-select
            v-model="libraryIds"
            :items="libraryOptions"
            :label="$formatMessage(messages.libraries)"
            multiple
            chips
            closable-chips
            clearable
            hide-details
            density="compact"
            style="min-width: 240px; max-width: 480px"
          />
        </div>
      </template>

      <template #no-data>
        <EmptyStateNetworkError v-if="error" />
        <template v-else>{{ $formatMessage(messages.nothing) }}</template>
      </template>

      <template #[`item.libraryId`]="{ value }">{{ libraryName(value) }}</template>

      <template #[`item.name`]="{ item }">
        <RouterLink :to="{ name: '/book/[id]', params: { id: item.id } }">{{
          item.name
        }}</RouterLink>
      </template>

      <template #[`item.media.status`]="{ value }">
        {{ $formatMessage(mediaStatusMessages[value as MediaStatus]) }}
      </template>

      <template #[`item.media.comment`]="{ value }">{{ convertErrorCodes(value) }}</template>

      <template #[`item.deleted`]="{ value }">
        <v-chip
          v-if="value"
          :text="$formatMessage(commonMessages.mediaPageUnavailable)"
          color="error"
          size="small"
          label
        />
      </template>

      <template #[`item.actions`]="{ item }">
        <v-btn
          v-ktooltip:bottom="$formatMessage(messages.analyze)"
          icon="i-mdi:magnify-scan"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.analyze)"
          @click="analyze(item)"
        />
      </template>
    </v-data-table-server>
  </v-container>
</template>

<script lang="ts" setup>
/**
 * Books whose analysis did not succeed, and a way to try each one again.
 *
 * This is the legacy media analysis page: a table of the books the server could
 * not read or does not support, with what it said about each.
 */
import { useQuery } from '@pinia/colada'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
import { bookListQuery, useAnalyzeBook } from '@/colada/books'
import { useLibraries } from '@/colada/libraries'
import { useErrorCodeFormatter } from '@/composables/errorCodeFormatter'
import { ANALYSIS_STATUSES, analysisSearch, type AnalysisStatus } from '@/functions/media-pages'
import type { BookDto } from '@/generated/openapi'
import { useMessagesStore } from '@/stores/messages'
import { mediaStatusMessages, type MediaStatus } from '@/types/MediaStatus'
import { PageRequest, type VSortItem } from '@/types/PageRequest'
import { commonMessages } from '@/utils/i18n/common-messages'

const intl = useIntl()
const messagesStore = useMessagesStore()
const { convertErrorCodes } = useErrorCodeFormatter()

const statuses = ref<AnalysisStatus[]>([...ANALYSIS_STATUSES])
const libraryIds = ref<string[]>([])
const sortBy = ref<VSortItem[]>([{ key: 'media.status', order: 'asc' }])
const pageRequest = ref<PageRequest>(new PageRequest(0, 20))

const { data: libraries } = useLibraries()
const libraryOptions = computed(() =>
  (libraries.value ?? []).map((library) => ({ title: library.name, value: library.id })),
)
const libraryName = (id: string) =>
  libraries.value?.find((library) => library.id === id)?.name ?? id

const search = computed(() => analysisSearch(statuses.value, libraryIds.value ?? []))

// The chips always leave a status chosen, so there is always something to look
// for; the table shows nothing in the moment there is not.
const { data, isLoading, error, refetch } = useQuery(() =>
  bookListQuery({ search: search.value ?? {}, pageRequest: pageRequest.value }),
)

function updateOptions(options: { page: number; itemsPerPage: number; sortBy: VSortItem[] }) {
  pageRequest.value = PageRequest.FromVuetify(
    options.page - 1,
    options.itemsPerPage,
    options.sortBy,
  )
}

const { mutateAsync: analyzeBook } = useAnalyzeBook()

function analyze(book: BookDto) {
  analyzeBook(book.id)
    .then(() =>
      messagesStore.messages.push({
        message: intl.formatMessage(valueMessages.analyzing, { book: book.name }),
      }),
    )
    .catch(() => messagesStore.messages.push(commonMessages.networkError))
}

const messages = defineMessages({
  title: {
    description: 'Media analysis page: title',
    defaultMessage: 'Media analysis',
    id: 'KfkPnJ',
  },
  libraries: {
    description: 'Media analysis page: library filter label',
    defaultMessage: 'Libraries',
    id: 'Sjb+Pm',
  },
  nothing: {
    description: 'Media analysis page: shown when no book matches',
    defaultMessage: 'No book with this status',
    id: 'J2W78X',
  },
  analyze: {
    description: 'Media analysis page: button that analyses a book again',
    defaultMessage: 'Analyze again',
    id: 'UQfGKE',
  },
  library: {
    description: 'Media analysis page: column header, library',
    defaultMessage: 'Library',
    id: 'Ykpjyj',
  },
  name: {
    description: 'Media analysis page: column header, book name',
    defaultMessage: 'Name',
    id: '4V691v',
  },
  status: {
    description: 'Media analysis page: column header, media status',
    defaultMessage: 'Status',
    id: 'IoIHQt',
  },
  comment: {
    description: 'Media analysis page: column header, what the analysis said',
    defaultMessage: 'Comment',
    id: 'CHLGA8',
  },
})

const valueMessages: Record<'analyzing', MessageDescriptor> = defineMessages({
  analyzing: {
    description: 'Media analysis page: notification after asking for a book to be analysed again',
    defaultMessage: 'Analysis queued: {book}',
    id: '3crE5G',
  },
})

const headers = [
  { title: intl.formatMessage(messages.library), key: 'libraryId', sortable: false },
  { title: intl.formatMessage(messages.name), key: 'name' },
  { title: intl.formatMessage(messages.status), key: 'media.status' },
  { title: intl.formatMessage(messages.comment), key: 'media.comment' },
  { title: intl.formatMessage(commonMessages.mediaPageMediaType), key: 'media.mediaType' },
  { title: intl.formatMessage(commonMessages.mediaPageUrl), key: 'url' },
  { title: intl.formatMessage(commonMessages.mediaPageSize), key: 'size', sortable: true },
  { title: '', key: 'deleted', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
