<template>
  <v-container fluid>
    <v-alert
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
      :text="$formatMessage(commonMessages.bulkEditHint)"
    />

    <v-row>
      <v-col>
        <ComboboxTag
          v-model="model.tags"
          include="BOOK"
        />
      </v-col>
    </v-row>

    <v-row
      v-for="role in roles"
      :key="role"
    >
      <v-col>
        <ComboboxContributor
          :model-value="namesOf(role)"
          :role="role"
          @update:model-value="(names: string[]) => setNames(role, names)"
        />
      </v-col>
    </v-row>

    <v-row>
      <v-col class="d-flex justify-end">
        <BtnAddRole
          :exclude-roles="roles"
          @add-role="(role) => addRole(role)"
        />
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
/**
 * The form for editing several books at once: their tags and who made them. It
 * starts empty, and what is left empty is left alone on every book.
 */
import type { BookBulkForm } from '@/functions/bulk-metadata'
import { commonMessages } from '@/utils/i18n/common-messages'

const model = defineModel<BookBulkForm>({ required: true })

// The roles most books have; others are added with the button.
const roles = ref<string[]>(['writer', 'penciller'])

function namesOf(role: string): string[] {
  return model.value.authors.filter((author) => author.role === role).map((author) => author.name)
}

function setNames(role: string, names: string[]) {
  model.value.authors = [
    ...model.value.authors.filter((author) => author.role !== role),
    ...names.map((name) => ({ role, name })),
  ]
}

function addRole(role: string) {
  if (role && !roles.value.includes(role)) roles.value.push(role)
}
</script>
