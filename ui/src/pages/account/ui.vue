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
        <v-switch
          :model-value="userSettings[ClientSettingUser.PosterStretch]"
          :label="$formatMessage(messages.stretch)"
          :hint="$formatMessage(messages.stretchHint)"
          :disabled="saving"
          color="primary"
          persistent-hint
          class="mb-4"
          @update:model-value="(value) => save(ClientSettingUser.PosterStretch, value === true)"
        />

        <v-switch
          :model-value="userSettings[ClientSettingUser.PosterBlurUnread]"
          :label="$formatMessage(messages.blur)"
          :hint="$formatMessage(messages.blurHint)"
          :disabled="saving"
          color="primary"
          persistent-hint
          @update:model-value="(value) => save(ClientSettingUser.PosterBlurUnread, value === true)"
        />
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script lang="ts" setup>
import { defineMessage } from 'vue-intl'
import { useClientSettingsUser, useUpdateClientSettingsUser } from '@/colada/client-settings'
import { ClientSettingUser } from '@/types/ClientSettingsUser'
import { useMessagesStore } from '@/stores/messages'
import { commonMessages } from '@/utils/i18n/common-messages'

const messagesStore = useMessagesStore()

const { userSettings, error, isPending } = useClientSettingsUser()
const { mutateAsync } = useUpdateClientSettingsUser()

const saving = ref(false)

// A switch is saved as it is flipped: there is nothing else on the page to save with it.
function save(
  key: typeof ClientSettingUser.PosterStretch | typeof ClientSettingUser.PosterBlurUnread,
  value: boolean,
) {
  saving.value = true
  mutateAsync({ [key]: value })
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
  stretch: defineMessage({
    description: 'Account UI settings: switch to stretch posters',
    defaultMessage: 'Stretch poster to fit card',
    id: '9CcdgO',
  }),
  stretchHint: defineMessage({
    description: 'Account UI settings: hint under the stretch posters switch',
    defaultMessage:
      'When off, the whole poster is shown, with space around it if it is not the shape of the card.',
    id: 'rgdFdd',
  }),
  blur: defineMessage({
    description: 'Account UI settings: switch to blur posters of unread items',
    defaultMessage: 'Blur poster for unread books and series',
    id: '0LxDVu',
  }),
  blurHint: defineMessage({
    description: 'Account UI settings: hint under the blur posters switch',
    defaultMessage: 'A book is unread until you open it; a series until you open one of its books.',
    id: 'iyAi4V',
  }),
  saved: defineMessage({
    description: 'Snackbar notification shown when an interface setting is saved',
    defaultMessage: 'Setting saved',
    id: 'CPpA//',
  }),
}
</script>
