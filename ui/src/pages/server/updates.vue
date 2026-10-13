<template>
  <v-container fluid>
    <v-skeleton-loader
      v-if="isLoading"
      type="heading, text, paragraph@3"
    />

    <EmptyStateNetworkError v-else-if="error" />

    <v-alert
      v-else-if="releases && releases.length === 0"
      type="info"
      variant="tonal"
    >
      {{
        $formatMessage({
          description: 'Updates view: shown when the server lists no releases',
          defaultMessage: 'This server is not set to look for updates.',
          id: 'c5nC6I',
        })
      }}
    </v-alert>

    <template v-else-if="releases">
      <v-row>
        <v-col>
          <div v-if="isLatestVersion == true">
            <v-alert
              type="success"
              variant="tonal"
            >
              {{
                $formatMessage({
                  description: 'Updates view: banner shown at the top',
                  defaultMessage: 'The latest version is already installed',
                  id: 'Pncpp3',
                })
              }}
            </v-alert>
          </div>
          <div v-if="isLatestVersion == false">
            <v-alert
              type="warning"
              variant="tonal"
            >
              {{
                $formatMessage({
                  description: 'Updates view: banner shown at the top',
                  defaultMessage: 'Updates are available',
                  id: 'n1Ik+L',
                })
              }}
            </v-alert>
          </div>
        </v-col>
      </v-row>

      <div
        v-for="(release, index) in releases"
        :key="index"
      >
        <ReleaseCard
          :release="release"
          :current="release.version == currentVersion"
          :latest="release.version == latest?.version"
          class="my-4"
        />
      </div>
    </template>
  </v-container>
</template>

<script lang="ts" setup>
import EmptyStateNetworkError from '@/components/EmptyStateNetworkError.vue'
import { useAppReleasesEnriched } from '@/composables/app-releases'

const {
  releases,
  error,
  buildVersion: currentVersion,
  isLatestVersion,
  latestRelease: latest,
  isLoading,
} = useAppReleasesEnriched()
</script>

<route lang="yaml">
meta:
  requiresRole: ADMIN
</route>
