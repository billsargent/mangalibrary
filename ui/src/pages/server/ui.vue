<template>
  <v-container
    fluid
    class="pa-0 pa-sm-4"
  >
    <v-skeleton-loader
      v-if="isPending"
      type="list-item-two-line@2"
    />

    <EmptyStateNetworkError v-else-if="error" />

    <v-card
      v-else
      max-width="600px"
    >
      <v-card-text>
        <v-radio-group
          :model-value="seriesGroups.name"
          :label="$formatMessage(messages.seriesGroups)"
          :hint="$formatMessage(messages.seriesGroupsHint)"
          :disabled="saving"
          color="primary"
          persistent-hint
          @update:model-value="(value) => saveSeriesGroups(value)"
        >
          <v-radio
            v-for="name in SeriesGroupsNames"
            :key="name"
            :value="name"
            :label="$formatMessage(groupMessages[name])"
          />
        </v-radio-group>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script lang="ts" setup>
import { defineMessage, type MessageDescriptor } from 'vue-intl'
import { useClientSettingsGlobal, useUpdateClientSettingsGlobal } from '@/colada/client-settings'
import { seriesGroupsUpdate } from '@/functions/series-groups'
import { type SeriesGroupsName, SeriesGroupsNames } from '@/types/ClientSettingsGlobal'
import { useMessagesStore } from '@/stores/messages'
import { commonMessages } from '@/utils/i18n/common-messages'

const messagesStore = useMessagesStore()

const { seriesGroups, error, isPending } = useClientSettingsGlobal()
const { mutateAsync } = useUpdateClientSettingsGlobal()

const saving = ref(false)

function saveSeriesGroups(value: unknown) {
  if (!(SeriesGroupsNames as readonly unknown[]).includes(value)) return
  saving.value = true
  mutateAsync(seriesGroupsUpdate(value as SeriesGroupsName))
    .then(() => {
      messagesStore.messages.push(messages.saved)
    })
    .catch((error) => {
      messagesStore.messages.push(error?.cause?.message ?? commonMessages.networkError)
    })
    .finally(() => {
      saving.value = false
    })
}

const messages = {
  seriesGroups: defineMessage({
    description: 'Server UI settings: label of the series grouping choice',
    defaultMessage: 'Series grouping',
    id: 'hH1IX3',
  }),
  seriesGroupsHint: defineMessage({
    description: 'Server UI settings: hint under the series grouping choice',
    defaultMessage:
      'The groups series are filed under when browsing a library by first character. Applies to everyone.',
    id: 'A2V2dy',
  }),
  saved: defineMessage({
    description: 'Snackbar notification shown when a server interface setting is saved',
    defaultMessage: 'Setting saved for everyone',
    id: 'MWHayq',
  }),
}

const groupMessages: Record<SeriesGroupsName, MessageDescriptor> = {
  alpha: defineMessage({
    description: 'Server UI settings: series grouping by the Latin alphabet',
    defaultMessage: 'Alphabetical',
    id: 'XQgUTB',
  }),
  japanese: defineMessage({
    description: 'Server UI settings: series grouping by the Japanese syllabary',
    defaultMessage: 'Gojūon (Japanese)',
    id: 'aueqJd',
  }),
}
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
