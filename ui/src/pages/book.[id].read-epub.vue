<template>
  <v-container class="fill-height">
    <v-empty-state
      icon="i-mdi:book-open-page-variant-outline"
      :title="
        $formatMessage({
          description: 'EPUB reader placeholder: title',
          defaultMessage: 'The EPUB reader is not available yet',
          id: 'bFTGEk',
        })
      "
      :text="
        $formatMessage({
          description: 'EPUB reader placeholder: text',
          defaultMessage:
            'Books made of text cannot be read here yet. You can download the file from the book page.',
          id: 'CsYKkd',
        })
      "
    >
      <template #actions>
        <v-btn
          :text="
            $formatMessage({
              description: 'EPUB reader placeholder: button back to the book page',
              defaultMessage: 'Back to the book',
              id: 'kCj2gy',
            })
          "
          :to="{ name: '/book/[id]', params: { id: route.params.id } }"
        />
      </template>
    </v-empty-state>
  </v-container>
</template>

<script lang="ts" setup>
// The address the application sends an EPUB to. The reader itself is not ported
// yet; this says so, instead of leaving the reader at "Page not found".
const route = useRoute('/book.[id].read-epub')
</script>

<route lang="yaml">
meta:
  layout: single
  requiresRole: PAGE_STREAMING
</route>
