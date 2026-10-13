<template>
  <v-container fluid>
    <v-alert
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
      :text="$formatMessage(commonMessages.bulkEditHint)"
    />

    <v-row>
      <v-col
        cols="12"
        sm="4"
      >
        <v-text-field
          v-model="model.publisher"
          clearable
          :label="$formatMessage(commonMessages.seriesFormGeneralPublisher)"
        />
      </v-col>
      <v-col
        cols="12"
        sm="4"
      >
        <v-select
          v-model="model.status"
          :items="seriesStatusOptions"
          clearable
          :label="
            $formatMessage({
              description: 'Form bulk edit series: publishing status',
              defaultMessage: 'Publishing status',
              id: 'k7AMko',
            })
          "
        />
      </v-col>
      <v-col
        cols="12"
        sm="4"
      >
        <v-select
          v-model="model.readingDirection"
          :items="readingDirectionOptions"
          clearable
          :label="$formatMessage(commonMessages.seriesFormGeneralReadingDirection)"
        />
      </v-col>
    </v-row>

    <v-row>
      <v-col
        cols="12"
        sm="6"
      >
        <v-text-field
          v-model="model.language"
          clearable
          :rules="
            [['bcp47', $formatMessage(commonMessages.bcp47Error)]] satisfies CustomRuleTuple[]
          "
          :label="$formatMessage(commonMessages.seriesFormGeneralLanguage)"
          :hint="$formatMessage(commonMessages.seriesFormGeneralLanguageHint)"
        />
      </v-col>
      <v-col
        cols="12"
        sm="6"
      >
        <v-number-input
          v-model="model.ageRating"
          clearable
          :min="0"
          :label="$formatMessage(commonMessages.seriesFormGeneralAgeRating)"
        />
      </v-col>
    </v-row>

    <v-row>
      <v-col>
        <ComboboxGenre v-model="model.genres" />
      </v-col>
    </v-row>
    <v-row>
      <v-col>
        <ComboboxTag
          v-model="model.tags"
          include="SERIES"
        />
      </v-col>
    </v-row>
    <v-row>
      <v-col>
        <ComboboxSharingLabel v-model="model.sharingLabels" />
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
/**
 * The form for editing several series at once. It starts empty, and what is left
 * empty is left alone on every series.
 */
import { useIntl } from 'vue-intl'
import type { SeriesBulkForm } from '@/functions/bulk-metadata'
import type { CustomRuleTuple } from '@/plugins/vuetify'
import { readingDirectionMessages, ReadingDirectionValues } from '@/types/ReadingDirection'
import { seriesStatusMessages, SeriesStatusValues } from '@/types/SeriesStatus'
import { commonMessages } from '@/utils/i18n/common-messages'

const intl = useIntl()

const model = defineModel<SeriesBulkForm>({ required: true })

const readingDirectionOptions = ReadingDirectionValues.map((value) => ({
  title: intl.formatMessage(readingDirectionMessages[value]),
  value,
}))
const seriesStatusOptions = SeriesStatusValues.map((value) => ({
  title: intl.formatMessage(seriesStatusMessages[value]),
  value,
}))
</script>
