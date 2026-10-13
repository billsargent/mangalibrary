<template>
  <div>
    <div class="d-flex align-center ga-2 mb-2">
      <span class="text-medium-emphasis">{{ hint }}</span>
      <v-spacer />
      <v-btn
        prepend-icon="i-mdi:plus"
        variant="tonal"
        :text="addText"
        class="flex-shrink-0"
        @click="emit('add', $event)"
      />
    </div>

    <v-progress-linear
      v-if="loading"
      indeterminate
      height="3"
    />

    <v-list
      lines="two"
      density="compact"
      class="py-0"
    >
      <VueDraggable
        v-model="rows"
        :disabled="!orderable"
        :animation="150"
        handle=".contents-handle"
        ghost-class="ghost"
      >
        <v-list-item
          v-for="(item, index) in rows"
          :key="item.id"
          :title="item.title"
          :subtitle="item.subtitle"
        >
          <template #prepend>
            <v-icon
              v-if="orderable"
              icon="i-mdi:drag-horizontal"
              class="contents-handle cursor-grab me-2"
            />
            <span class="text-medium-emphasis me-3">{{ index + 1 }}</span>
          </template>

          <template #append>
            <template v-if="orderable">
              <v-btn
                icon="i-mdi:arrow-up"
                variant="text"
                size="small"
                :disabled="index === 0"
                :aria-label="$formatMessage(messages.up, { title: item.title })"
                @click="move(index, -1)"
              />
              <v-btn
                icon="i-mdi:arrow-down"
                variant="text"
                size="small"
                :disabled="index === rows.length - 1"
                :aria-label="$formatMessage(messages.down, { title: item.title })"
                @click="move(index, 1)"
              />
            </template>
            <v-btn
              icon="i-mdi:close"
              variant="text"
              size="small"
              :disabled="rows.length === 1"
              :aria-label="$formatMessage(messages.remove, { title: item.title })"
              @click="model = withRemoved(model, item.id)"
            />
          </template>
        </v-list-item>
      </VueDraggable>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { defineMessage, type MessageDescriptor } from 'vue-intl'
import { VueDraggable } from 'vue-draggable-plus'
import { type ContentsItem, contentsRows, withRemoved } from '@/functions/contents'

/**
 * The things in a collection or a read list, to remove, to put in order, and to add to.
 *
 * The last one cannot be removed: a collection or a read list with nothing in it is
 * not one the server keeps.
 */
const model = defineModel<string[]>({ required: true })

const { known } = defineProps<{
  /** What is known of each id: its title, and a line under it. */
  known: Map<string, Omit<ContentsItem, 'id'>>
  /** Whether the order is the user's to set. */
  orderable: boolean
  loading?: boolean
  /** Said above the list. */
  hint: string
  addText: string
}>()

const emit = defineEmits<{
  add: [event: Event]
}>()

const rows = computed<ContentsItem[]>({
  get: () => contentsRows(model.value, known),
  set: (value) => (model.value = value.map((item) => item.id)),
})

// The arrows do what dragging does, for a keyboard and for a touch screen.
function move(index: number, by: -1 | 1) {
  const ids = [...model.value]
  const [moved] = ids.splice(index, 1)
  if (moved === undefined) return
  ids.splice(index + by, 0, moved)
  model.value = ids
}

const messages: Record<'up' | 'down' | 'remove', MessageDescriptor> = {
  up: defineMessage({
    description: 'Contents editor: accessible name of the button moving an item up',
    defaultMessage: 'Move {title} up',
    id: 'M9zZUl',
  }),
  down: defineMessage({
    description: 'Contents editor: accessible name of the button moving an item down',
    defaultMessage: 'Move {title} down',
    id: 'KmmaIc',
  }),
  remove: defineMessage({
    description: 'Contents editor: accessible name of the button removing an item',
    defaultMessage: 'Remove {title}',
    id: 'QuzTFt',
  }),
}
</script>

<style scoped>
.ghost {
  opacity: 0.4;
}
</style>
