<template>
  <v-container
    fluid
    class="pa-0 pa-sm-4 h-100 h-sm-auto"
  >
    <v-data-table-server
      v-model:sort-by="sortBy"
      :loading="isLoading"
      :items="data?.content"
      :items-length="data?.totalElements ?? 0"
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
              icon="i-mdi:image-off-outline"
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
      </template>

      <template #no-data>
        <EmptyStateNetworkError v-if="error" />
        <template v-else>{{ $formatMessage(messages.nothing) }}</template>
      </template>

      <template #[`item.seriesTitle`]="{ item }">
        <RouterLink :to="{ name: '/series/[id]', params: { id: item.seriesId } }">{{
          item.seriesTitle
        }}</RouterLink>
      </template>

      <template #[`item.metadata.title`]="{ item }">
        <RouterLink :to="{ name: '/book/[id]', params: { id: item.id } }">{{
          item.metadata.title
        }}</RouterLink>
      </template>

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
          v-ktooltip:bottom="$formatMessage(messages.edit)"
          icon="i-mdi:image-plus-outline"
          variant="text"
          density="comfortable"
          :aria-label="$formatMessage(messages.edit)"
          @mouseenter="(event: Event) => (editActivator = event.currentTarget as Element)"
          @click="editBook(item)"
        />
      </template>
    </v-data-table-server>
  </v-container>
</template>

<script lang="ts" setup>
/**
 * Books that were read without trouble and still have no poster chosen.
 *
 * This is the legacy missing posters page. Each row opens the book's metadata
 * dialog, whose poster tab is where one is uploaded or picked.
 */
import { useQuery } from '@pinia/colada'
import { defineMessages, useIntl } from 'vue-intl'
import { bookListQuery } from '@/colada/books'
import { useEditBookMetadataDialog } from '@/composables/book/useEditBookMetadataDialog'
import { missingPostersSearch } from '@/functions/media-pages'
import type { BookDto } from '@/generated/openapi'
import { PageRequest, type VSortItem } from '@/types/PageRequest'
import { commonMessages } from '@/utils/i18n/common-messages'

const intl = useIntl()

const sortBy = ref<VSortItem[]>([])
const pageRequest = ref<PageRequest>(new PageRequest(0, 20))
const search = missingPostersSearch()

const { data, isLoading, error, refetch } = useQuery(() =>
  bookListQuery({ search, pageRequest: pageRequest.value }),
)

function updateOptions(options: { page: number; itemsPerPage: number; sortBy: VSortItem[] }) {
  pageRequest.value = PageRequest.FromVuetify(
    options.page - 1,
    options.itemsPerPage,
    options.sortBy,
  )
}

const { prepareDialog, activator: editActivator } = useEditBookMetadataDialog()

function editBook(book: BookDto) {
  // A poster added in the dialog takes the book off this list.
  prepareDialog(book, () => void refetch())
}

const messages = defineMessages({
  title: {
    description: 'Missing posters page: title',
    defaultMessage: 'Missing posters',
    id: '1T59g0',
  },
  nothing: {
    description: 'Missing posters page: shown when every book has a poster',
    defaultMessage: 'Every book has a poster',
    id: 'mPZAa4',
  },
  edit: {
    description: 'Missing posters page: button that opens the book dialog to add a poster',
    defaultMessage: 'Add a poster',
    id: 'FkCmZk',
  },
  series: {
    description: 'Missing posters page: column header, series',
    defaultMessage: 'Series',
    id: 'QFOnnV',
  },
  book: {
    description: 'Missing posters page: column header, book',
    defaultMessage: 'Book',
    id: 'FmHb6a',
  },
})

const headers = [
  { title: intl.formatMessage(messages.series), key: 'seriesTitle', sortable: false },
  { title: intl.formatMessage(messages.book), key: 'metadata.title' },
  { title: intl.formatMessage(commonMessages.mediaPageMediaType), key: 'media.mediaType' },
  { title: intl.formatMessage(commonMessages.mediaPageUrl), key: 'url' },
  { title: '', key: 'deleted', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
