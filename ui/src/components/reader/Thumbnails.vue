<template>
  <v-dialog
    v-model="shown"
    max-width="1000"
    scrollable
  >
    <v-card>
      <v-toolbar
        color="primary"
        density="compact"
      >
        <v-btn
          icon="i-mdi:close"
          :aria-label="
            $formatMessage({
              description: 'Reader page explorer: close button',
              defaultMessage: 'Close',
              id: 'ZJqP9x',
            })
          "
          @click="shown = false"
        />
        <v-toolbar-title>
          {{
            $formatMessage({
              description: 'Reader page explorer: title',
              defaultMessage: 'Pages',
              id: '9/ZR/T',
            })
          }}
        </v-toolbar-title>
      </v-toolbar>

      <v-card-text class="thumbnails">
        <button
          v-for="number in pageCount"
          :key="number"
          type="button"
          class="thumbnail"
          :class="{ 'thumbnail--current': number === currentPage }"
          @click="choose(number)"
        >
          <v-img
            :src="bookPageThumbnailUrl(bookId, number)"
            lazy-src="@/assets/cover.svg"
            aspect-ratio="0.7071"
            cover
          />
          <span class="text-body-small">{{ number }}</span>
        </button>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { bookPageThumbnailUrl } from '@/api/images'

/** Every page of the book as a small picture, to jump to one by sight. */
defineProps<{
  bookId: string
  pageCount: number
  currentPage: number
}>()

const shown = defineModel<boolean>({ required: true })

const emit = defineEmits<{ go: [page: number] }>()

function choose(page: number) {
  emit('go', page)
  shown.value = false
}
</script>

<style scoped>
.thumbnails {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 12px;
}

.thumbnail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  border: 2px solid transparent;
  border-radius: 6px;
  text-align: center;
  cursor: pointer;
}

.thumbnail:hover,
.thumbnail:focus-visible {
  border-color: rgba(var(--v-theme-on-surface), 0.4);
}

.thumbnail--current {
  border-color: rgb(var(--v-theme-primary));
}
</style>
