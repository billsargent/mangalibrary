<template>
  <v-menu>
    <template #activator="{ props }">
      <v-icon-btn
        v-ktooltip:bottom="
          $formatMessage({
            description: 'Locale selector button: tooltip',
            defaultMessage: 'Language',
            id: 'XR+P68',
          })
        "
        v-bind="props"
        icon="i-mdi:translate"
        :aria-label="
          $formatMessage({
            description: 'Locale selector button: aria-label',
            defaultMessage: 'language selector',
            id: 'dQ9kx9',
          })
        "
      />
    </template>

    <v-list
      :selected="[currentLocale]"
      color="primary"
    >
      <v-list-subheader
        :title="
          $formatMessage({
            description: 'Translations pop-up menu header',
            defaultMessage: 'Translations',
            id: 'InW6ko',
          })
        "
        class="text-high-emphasis text-uppercase font-weight-black"
      />

      <v-list-item
        v-for="locale in locales"
        :key="locale.value"
        :title="locale.title"
        :value="locale.value"
        @click="setLocale(locale.value)"
      />
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { availableLocales, currentLocale, setLocale } from '@/utils/i18n/locale-helper'

const locales = Object.entries(availableLocales).map(([code, localeInfo]) => ({
  title: localeInfo.nameLocalized,
  value: code,
}))
</script>

<script lang="ts"></script>

<style scoped></style>
