<template>
  <template v-if="display.xs.value">
    <div class="d-flex align-center text-body-medium pa-2">
      <RouterLink
        to="/"
        class="text-decoration-none text-high-emphasis"
      >
        <AppName />
      </RouterLink>
    </div>
    <v-divider />
  </template>
</template>

<script setup lang="ts">
import { useDisplay } from 'vuetify'

const display = useDisplay()
</script>
