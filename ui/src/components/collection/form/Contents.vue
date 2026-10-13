<template>
  <v-sheet class="pa-4">
    <ContentsEditor
      v-model="model"
      :known="known"
      :orderable="ordered"
      :loading="isLoading"
      :hint="$formatMessage(ordered ? messages.hintOrdered : messages.hintByName)"
      :add-text="$formatMessage(messages.add)"
      @add="picker = true"
    />

    <DialogSeriesPicker
      v-model:dialog="picker"
      :fullscreen="display.xs.value"
      @selected-series="(series) => add(series)"
    />
  </v-sheet>
</template>

<script setup lang="ts">
import { defineMessage } from 'vue-intl'
import { useQuery } from '@pinia/colada'
import { useDisplay } from 'vuetify'
import { seriesListQuery } from '@/colada/series'
import { PageRequest } from '@/types/PageRequest'
import type { SeriesDto } from '@/generated/openapi'
import { type ContentsItem, withAdded } from '@/functions/contents'

/** The ids of the series in the collection, in order. */
const model = defineModel<string[]>({ required: true })

const { collectionId } = defineProps<{
  collectionId: string
  /** Whether the collection is ordered by hand. */
  ordered: boolean
}>()

const display = useDisplay()
const picker = ref(false)

const { data, isLoading } = useQuery(() =>
  seriesListQuery({
    search: { condition: { collectionId: { operator: 'is', value: collectionId } } },
    pageRequest: PageRequest.Unpaged(),
  }),
)

// Series added here are not in the collection on the server yet, so their names
// are kept from the picker.
const added = ref<SeriesDto[]>([])
const known = computed(
  () =>
    new Map<string, Omit<ContentsItem, 'id'>>(
      [...(data.value?.content ?? []), ...added.value].map((series) => [
        series.id,
        { title: series.metadata.title },
      ]),
    ),
)

function add(series: SeriesDto) {
  added.value.push(series)
  model.value = withAdded(model.value, series.id)
  picker.value = false
}

const messages = {
  hintOrdered: defineMessage({
    description: 'Form edit collection: Contents - hint when the collection is ordered manually',
    defaultMessage: 'Drag a series, or use the arrows, to set the order.',
    id: 'j89WCe',
  }),
  hintByName: defineMessage({
    description: 'Form edit collection: Contents - hint when the collection is ordered by name',
    defaultMessage: 'Shown by name. Choose manual ordering under General to set an order.',
    id: 'q8fOON',
  }),
  add: defineMessage({
    description: 'Form edit collection: Contents - button to add a series',
    defaultMessage: 'Add series',
    id: 'Sz+ZZ5',
  }),
}
</script>
