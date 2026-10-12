<template>
  <v-dialog
    v-model="shown"
    max-width="900"
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
              description: 'Reader keyboard shortcuts: close button',
              defaultMessage: 'Close',
              id: 'fk3rFu',
            })
          "
          @click="shown = false"
        />
        <v-toolbar-title>
          {{
            $formatMessage({
              description: 'Reader keyboard shortcuts: title',
              defaultMessage: 'Keyboard shortcuts',
              id: 'ZKPtkT',
            })
          }}
        </v-toolbar-title>
      </v-toolbar>

      <v-card-text>
        <v-row>
          <v-col
            v-for="group in groups"
            :key="group.title"
            cols="12"
            md="4"
          >
            <div class="text-title-medium font-weight-bold mb-2">{{ group.title }}</div>
            <v-table density="compact">
              <tbody>
                <tr
                  v-for="shortcut in group.shortcuts"
                  :key="shortcut.keys"
                >
                  <td>
                    <kbd>{{ shortcut.keys }}</kbd>
                  </td>
                  <td>{{ shortcut.description }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/** What each key does in the reader, as the page that handles the keys describes it. */
export interface ShortcutGroup {
  title: string
  shortcuts: { keys: string; description: string }[]
}

defineProps<{ groups: ShortcutGroup[] }>()

const shown = defineModel<boolean>({ required: true })
</script>

<style scoped>
kbd {
  padding: 2px 6px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 4px;
  font-family: inherit;
  white-space: nowrap;
}
</style>
