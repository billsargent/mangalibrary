<template>
  <v-list v-if="items.length > 0">
    <div
      v-if="showModeSelector"
      class="px-4 pb-2"
    >
      <FilterAnyAll
        v-model="modelMode"
        text
        :props="{ color: color, density: 'compact', rounded: 'lg', mandatory: true }"
      />
    </div>
    <v-virtual-scroll :items="items">
      <template #default="{ item }">
        <FilterTriState
          v-model="internalModel[JSON.stringify(item)]"
          :label="item.title"
          :tri-state="!!item.valueExclude"
          :color="color"
          @change="(newVal, oldVal) => internalUpdate(item, newVal, oldVal)"
        />
      </template>
    </v-virtual-scroll>
    <div
      v-intersect.quiet="
        (isIntersecting: boolean) => (isIntersecting ? emit('loadMore') : undefined)
      "
    ></div>
  </v-list>
</template>

<script setup lang="ts">
import type { IncludeExclude } from '@/components/filter/TriState.vue'
import type { AnyAll } from '@/types/filter'
import { deepEqual } from 'fast-equals'

export type ItemType<T> = {
  title: string
  value: T
  valueExclude?: T
}

const model = defineModel<unknown[]>({ default: () => [] })
const modelMode = defineModel<AnyAll>('mode', { default: 'anyOf' })

const {
  items = [],
  color,
  showModeSelector = false,
} = defineProps<{
  items?: ItemType<unknown>[]
  color?: string
  showModeSelector?: boolean
}>()

const emit = defineEmits<{
  loadMore: []
}>()

const internalModel = ref<Record<string, IncludeExclude>>({})

function toModel(item: ItemType<unknown>, value: IncludeExclude) {
  if (value === 'include') return item.value
  if (value === 'exclude') return item.valueExclude
  return undefined
}

function internalUpdate(item: ItemType<unknown>, newVal: IncludeExclude, oldVal: IncludeExclude) {
  const oldEl = toModel(item, oldVal)
  const newEl = toModel(item, newVal)

  // remove old element if present
  const oldIndex = model.value.findIndex((it) => deepEqual(it, oldEl))
  let nextValue = oldIndex >= 0 ? model.value.toSpliced(oldIndex, 1) : model.value

  // add new element if defined
  if (newEl) nextValue = [...nextValue, newEl]

  model.value = nextValue
}

watchEffect(() => {
  internalModel.value = model.value.reduce((acc, item) => {
    const itemInclude = items.find((it) => deepEqual(it.value, item))
    if (itemInclude)
      return {
        ...(acc as Record<number, string | undefined>),
        [JSON.stringify(itemInclude)]: 'include',
      }

    const itemExclude = items.find((it) => deepEqual(it.valueExclude, item))
    if (itemExclude)
      return {
        ...(acc as Record<number, string | undefined>),
        [JSON.stringify(itemExclude)]: 'exclude',
      }

    return acc
  }, {}) as Record<string, IncludeExclude>
})
</script>

<script lang="ts"></script>

<style scoped></style>
