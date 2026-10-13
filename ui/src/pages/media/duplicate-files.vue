<template>
  <v-container
    fluid
    class="pa-0 pa-sm-4 h-100 h-sm-auto"
  >
    <v-data-table-server
      :loading="isLoading"
      :items="data?.content"
      :items-length="data?.totalElements ?? 0"
      :items-per-page-options="[20, 50, 100]"
      :items-per-page="20"
      :headers="headers"
      fixed-header
      fixed-footer
      mobile-breakpoint="md"
      style="height: 100%"
      @update:options="updateOptions"
    >
      <template #top>
        <v-toolbar flat>
          <v-toolbar-title>
            <v-icon
              color="medium-emphasis"
              icon="i-mdi:file-multiple-outline"
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

      <template #[`item.url`]="{ item }">
        <RouterLink :to="{ name: '/book/[id]', params: { id: item.id } }">{{
          item.url
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
          v-ktooltip:bottom="$formatMessage(messages.delete)"
          icon="i-mdi:trash-can-outline"
          variant="text"
          color="error"
          density="comfortable"
          :aria-label="$formatMessage(messages.delete)"
          @mouseenter="(event: Event) => (dialogConfirm.activator = event.currentTarget as Element)"
          @click="deleteBook(item)"
        />
      </template>
    </v-data-table-server>
  </v-container>
</template>

<script lang="ts" setup>
/**
 * Books that are the same file as another book, grouped by what they have in
 * common, with a way to delete the copies. Rows that share a hash sit together.
 *
 * This is the legacy duplicate files page. The server lists the books whose file
 * hash another book shares, in hash order, so a group's rows arrive together.
 */
import { useQuery } from '@pinia/colada'
import { storeToRefs } from 'pinia'
import { defineMessages, type MessageDescriptor, useIntl } from 'vue-intl'
import { useDisplay } from 'vuetify'
import { QUERY_KEYS_BOOKS, useDeleteBook } from '@/colada/books'
import BookDeletionWarning from '@/components/book/DeletionWarning.vue'
import { komgaGetBooksDuplicates, type BookDto } from '@/generated/openapi'
import { type DialogResult, useDialogsStore } from '@/stores/dialogs'
import { useMessagesStore } from '@/stores/messages'
import { PageRequest, type VSortItem } from '@/types/PageRequest'
import { commonMessages } from '@/utils/i18n/common-messages'

const intl = useIntl()
const display = useDisplay()
const messagesStore = useMessagesStore()
const { confirm: dialogConfirm } = storeToRefs(useDialogsStore())

const pageRequest = ref<PageRequest>(new PageRequest(0, 20))

const { data, isLoading, error, refetch } = useQuery(() => ({
  // Under the books' key, so that a book deleted anywhere refreshes this list too.
  key: [...QUERY_KEYS_BOOKS.root, 'duplicates', JSON.stringify(pageRequest.value)],
  query: () => komgaGetBooksDuplicates({ query: { ...pageRequest.value } }),
}))

function updateOptions(options: { page: number; itemsPerPage: number; sortBy: VSortItem[] }) {
  // The order is the server's: by hash, which is what keeps a group together.
  pageRequest.value = PageRequest.FromVuetify(options.page - 1, options.itemsPerPage, [])
}

const { mutateAsync: mutateDelete } = useDeleteBook()

function deleteBook(book: BookDto) {
  dialogConfirm.value.dialogProps = {
    title: intl.formatMessage(messages.deleteTitle),
    subtitle: book.url,
    maxWidth: 600,
    mode: 'checkbox',
    color: 'error',
    okText: intl.formatMessage(messages.deleteConfirm),
    closeOnSave: true,
    fullscreen: display.xs.value,
  }
  dialogConfirm.value.slotWarning = { component: markRaw(BookDeletionWarning), props: {} }
  dialogConfirm.value.callback = (result: DialogResult) => {
    if (result !== 'confirm') return
    mutateDelete(book.id)
      .then(() => {
        messagesStore.messages.push({
          message: intl.formatMessage(valueMessages.deleted, { file: book.url }),
        })
        void refetch()
      })
      .catch(() => messagesStore.messages.push(commonMessages.networkError))
  }
}

const messages = defineMessages({
  title: {
    description: 'Duplicate files page: title',
    defaultMessage: 'Duplicate files',
    id: '77lbuR',
  },
  nothing: {
    description: 'Duplicate files page: shown when no two books are the same file',
    defaultMessage: 'No duplicate files',
    id: 'uOW19s',
  },
  delete: {
    description: 'Duplicate files page: button that deletes a book file',
    defaultMessage: 'Delete this file',
    id: 'tL8sb/',
  },
  deleteTitle: {
    description: 'Duplicate files page: delete dialog title',
    defaultMessage: 'Delete book file',
    id: 'AQJIPR',
  },
  deleteConfirm: {
    description: 'Duplicate files page: delete dialog confirm button',
    defaultMessage: 'Delete file',
    id: 'uMlTLv',
  },
  hash: {
    description: 'Duplicate files page: column header, file hash',
    defaultMessage: 'File hash',
    id: 'r5Jb1E',
  },
})

const valueMessages: Record<'deleted', MessageDescriptor> = defineMessages({
  deleted: {
    description: 'Duplicate files page: notification after a file was deleted',
    defaultMessage: 'File deleted: {file}',
    id: 'DcSoqa',
  },
})

const headers = [
  { title: intl.formatMessage(messages.hash), key: 'fileHash', sortable: false },
  { title: intl.formatMessage(commonMessages.mediaPageUrl), key: 'url', sortable: false },
  { title: intl.formatMessage(commonMessages.mediaPageSize), key: 'size', sortable: false },
  { title: '', key: 'deleted', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
