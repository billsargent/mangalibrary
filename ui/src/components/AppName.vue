<template>
  <span
    class="app-name"
    :class="{ 'app-name--large': large }"
    >Manga Library</span
  >
</template>

<script setup lang="ts">
/**
 * The application's name as a wordmark.
 *
 * It stands wherever a logo would: the fork has no logo of its own yet, and it
 * must not go on wearing Komga's. A name is not translated, so it is not a message.
 */
const { large = false } = defineProps<{
  /** The size for a page that has nothing else on it: sign-in, claim, start-up. */
  large?: boolean
}>()
</script>

<style scoped>
.app-name {
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.app-name--large {
  display: block;
  padding-block: 1.5rem;
  font-size: 2.25rem;
  line-height: 1.2;
  text-align: center;
}
</style>
