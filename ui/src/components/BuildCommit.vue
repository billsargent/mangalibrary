<template>
  <v-btn
    v-if="isLoading || commitId"
    :loading="isLoading"
    prepend-icon="i-mdi:source-commit"
    variant="text"
    color="grey"
    size="small"
    class="text-body-small"
    :href="'https://github.com/billsargent/mangalibrary/commits/' + commitId"
    target="_blank"
  >
    {{ commitId || $formatMessage(commonMessages.error) }}
  </v-btn>
</template>

<script setup lang="ts">
import { useActuatorInfo } from '@/colada/actuator-info'
import { commonMessages } from '@/utils/i18n/common-messages'

const { commitId, isLoading } = useActuatorInfo()
</script>
