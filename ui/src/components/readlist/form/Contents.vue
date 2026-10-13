<template>
  <v-sheet class="pa-4">
    <ContentsEditor
      v-model="model"
      :known="known"
      :orderable="ordered"
      :loading="isLoading"
      :hint="$formatMessage(ordered ? messages.hintOrdered : messages.hintByDate)"
      :add-text="$formatMessage(messages.add)"
      @add="seriesPicker = true"
    />

    <!-- A book is found through its series: pick the series, then the book in it. -->
    <DialogSeriesPicker
      v-model:dialog="seriesPicker"
      :fullscreen="display.xs.value"
      @selected-series="(series) => pickFrom(series)"
    />
    <DialogBookPicker
      v-model:dialog="bookPicker"
      :books="seriesBooks?.content"
      :fullscreen="display.xs.value"
      @selected-book="(book) => add(book)"
    />
  </v-sheet>
</template>

<script setup lang="ts">
import { defineMessage } from 'vue-intl'
import { useQuery } from '@pinia/colada'
import { useDisplay } from 'vuetify'
import { bookListQuery } from '@/colada/books'
import { PageRequest } from '@/types/PageRequest'
import type { BookDto, SeriesDto } from '@/generated/openapi'
import { type ContentsItem, withAdded } from '@/functions/contents'

/** The ids of the books in the read list, in order. */
const model = defineModel<string[]>({ required: true })

const { readListId } = defineProps<{
  readListId: string
  /** Whether the read list is ordered by hand. */
  ordered: boolean
}>()

const display = useDisplay()
const seriesPicker = ref(false)
const bookPicker = ref(false)
const pickedSeries = ref<SeriesDto>()

const { data, isLoading } = useQuery(() =>
  bookListQuery({
    search: { condition: { readListId: { operator: 'is', value: readListId } } },
    pageRequest: PageRequest.Unpaged(),
  }),
)

const { data: seriesBooks } = useQuery(() => ({
  ...bookListQuery({
    search: { condition: { seriesId: { operator: 'is', value: pickedSeries.value?.id ?? '' } } },
    pageRequest: PageRequest.Unpaged([{ key: 'metadata.numberSort', order: 'asc' }]),
  }),
  enabled: pickedSeries.value !== undefined,
}))

// Books added here are not in the read list on the server yet, so their names are
// kept from the picker.
const added = ref<BookDto[]>([])
const known = computed(
  () =>
    new Map<string, Omit<ContentsItem, 'id'>>(
      [...(data.value?.content ?? []), ...added.value].map((book) => [
        book.id,
        { title: book.metadata.title, subtitle: book.seriesTitle },
      ]),
    ),
)

function pickFrom(series: SeriesDto) {
  pickedSeries.value = series
  seriesPicker.value = false
  bookPicker.value = true
}

function add(book: BookDto) {
  added.value.push(book)
  model.value = withAdded(model.value, book.id)
  bookPicker.value = false
}

const messages = {
  hintOrdered: defineMessage({
    description: 'Form edit read list: Contents - hint when the read list is ordered manually',
    defaultMessage: 'Drag a book, or use the arrows, to set the order.',
    id: 'Q+DbYX',
  }),
  hintByDate: defineMessage({
    description: 'Form edit read list: Contents - hint when the read list is ordered by date',
    defaultMessage: 'Shown by release date. Choose manual ordering under General to set an order.',
    id: '00hWiT',
  }),
  add: defineMessage({
    description: 'Form edit read list: Contents - button to add a book',
    defaultMessage: 'Add book',
    id: 'Gvy6IU',
  }),
}
</script>
