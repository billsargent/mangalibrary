<template>
  <v-bottom-sheet
    v-model="shown"
    max-width="500"
    scrollable
  >
    <v-card>
      <v-toolbar
        color="primary"
        density="compact"
      >
        <v-btn
          icon="i-mdi:close"
          :aria-label="$formatMessage(messages.close)"
          @click="shown = false"
        />
        <v-toolbar-title>
          {{
            $formatMessage({
              description: 'Reader settings: title',
              defaultMessage: 'Reader settings',
              id: 'kN27W+',
            })
          }}
        </v-toolbar-title>
      </v-toolbar>

      <v-card-text class="d-flex flex-column ga-4 pt-6">
        <div class="text-title-medium font-weight-bold">
          {{
            $formatMessage({
              description: 'Reader settings: general section',
              defaultMessage: 'General',
              id: '9/axR0',
            })
          }}
        </div>

        <v-select
          v-model="readingDirection"
          :items="readingDirections"
          :label="
            $formatMessage({
              description: 'Reader settings: reading mode',
              defaultMessage: 'Reading mode',
              id: 'gE59HA',
            })
          "
          hide-details
        />
        <v-switch
          v-model="store.followSeriesDirection"
          :label="
            $formatMessage({
              description: 'Reader settings: let a series decide the reading mode of its books',
              defaultMessage: 'Use the reading mode a series names',
              id: 'ipL8XX',
            })
          "
          :hint="
            $formatMessage({
              description: 'Reader settings: hint for letting a series decide the reading mode',
              defaultMessage:
                'When off, the reading mode above is used for every book. When on, a series whose metadata names a mode is read in it.',
              id: 'TkshJ1',
            })
          "
          color="primary"
          persistent-hint
          class="mb-2"
        />
        <v-switch
          v-model="store.animations"
          :label="
            $formatMessage({
              description: 'Reader settings: animate page transitions',
              defaultMessage: 'Animate page transitions',
              id: '38i8Bp',
            })
          "
          color="primary"
          hide-details
        />
        <v-switch
          v-model="store.swipe"
          :label="
            $formatMessage({
              description: 'Reader settings: swipe gestures',
              defaultMessage: 'Gestures',
              id: 'MhWVXd',
            })
          "
          color="primary"
          hide-details
        />
        <v-switch
          v-model="store.alwaysFullscreen"
          :label="
            $formatMessage({
              description: 'Reader settings: always full screen',
              defaultMessage: 'Always full screen',
              id: '3TR/a/',
            })
          "
          :disabled="!fullscreenSupported"
          color="primary"
          hide-details
        />

        <div class="text-title-medium font-weight-bold">
          {{
            $formatMessage({
              description: 'Reader settings: display section',
              defaultMessage: 'Display',
              id: '84PzV/',
            })
          }}
        </div>
        <v-select
          v-model="store.background"
          :items="backgrounds"
          :label="
            $formatMessage({
              description: 'Reader settings: background colour',
              defaultMessage: 'Background color',
              id: 'PzbszR',
            })
          "
          hide-details
        />

        <template v-if="readingDirection === 'WEBTOON'">
          <div class="text-title-medium font-weight-bold">
            {{
              $formatMessage({
                description: 'Reader settings: webtoon section',
                defaultMessage: 'Webtoon',
                id: 'cQe6M2',
              })
            }}
          </div>
          <v-select
            v-model="store.continuousScale"
            :items="continuousScales"
            :label="$formatMessage(messages.scaleType)"
            hide-details
          />
          <v-select
            v-model="store.continuousPadding"
            :items="paddings"
            :label="
              $formatMessage({
                description: 'Reader settings: side padding of the webtoon reader',
                defaultMessage: 'Side padding',
                id: 'QoELLi',
              })
            "
            hide-details
          />
          <v-select
            v-model="store.continuousMargin"
            :items="margins"
            :label="
              $formatMessage({
                description: 'Reader settings: gap between two pages of the webtoon reader',
                defaultMessage: 'Page margin',
                id: 'iG5JHM',
              })
            "
            hide-details
          />
        </template>

        <template v-else>
          <div class="text-title-medium font-weight-bold">
            {{
              $formatMessage({
                description: 'Reader settings: paged section',
                defaultMessage: 'Paged',
                id: '1ohPeX',
              })
            }}
          </div>
          <v-select
            v-model="store.pagedScale"
            :items="pagedScales"
            :label="$formatMessage(messages.scaleType)"
            hide-details
          />
          <v-select
            v-model="store.pageLayout"
            :items="pageLayouts"
            :label="
              $formatMessage({
                description: 'Reader settings: page layout',
                defaultMessage: 'Page layout',
                id: '7tk6gh',
              })
            "
            hide-details
          />
        </template>
      </v-card-text>
    </v-card>
  </v-bottom-sheet>
</template>

<script setup lang="ts">
import { defineMessages, useIntl } from 'vue-intl'
import { useReaderStore } from '@/stores/reader'
import { readingDirectionMessages, ReadingDirectionValues } from '@/types/ReadingDirection'
import type { ReadingDirection } from '@/types/ReadingDirection'
import {
  backgroundColorMessages,
  BackgroundColors,
  continuousScaleTypeMessages,
  ContinuousScaleTypeValues,
  PaddingPercentages,
  pageLayoutMessages,
  PageLayoutValues,
  PageMargins,
  scaleTypeMessages,
  ScaleTypeValues,
} from '@/types/reader'

/**
 * The reader's settings, in a sheet over the book.
 *
 * Everything here is the reader store's, which keeps it, except the reading
 * direction: when series are followed a series can name its own, and that one
 * must apply to the book on screen without being saved as the reader's preference. The page that owns the
 * book decides which it is, so the direction is a model of its own.
 */
defineProps<{ fullscreenSupported: boolean }>()

const shown = defineModel<boolean>({ required: true })
const readingDirection = defineModel<ReadingDirection>('readingDirection', { required: true })

const store = useReaderStore()
const intl = useIntl()

const messages = defineMessages({
  close: {
    description: 'Reader settings: close button',
    defaultMessage: 'Close',
    id: 'RirQe8',
  },
  scaleType: {
    description: 'Reader settings: scale type',
    defaultMessage: 'Scale type',
    id: 'ay4mgr',
  },
  none: {
    description: 'Reader settings: no padding or margin',
    defaultMessage: 'None',
    id: 'gmuM7G',
  },
})

const readingDirections = computed(() =>
  ReadingDirectionValues.map((value) => ({
    value,
    title: intl.formatMessage(readingDirectionMessages[value]),
  })),
)
const backgrounds = computed(() =>
  BackgroundColors.map((value) => ({
    value,
    title: intl.formatMessage(backgroundColorMessages[value]),
  })),
)
const pagedScales = computed(() =>
  ScaleTypeValues.map((value) => ({ value, title: intl.formatMessage(scaleTypeMessages[value]) })),
)
const continuousScales = computed(() =>
  ContinuousScaleTypeValues.map((value) => ({
    value,
    title: intl.formatMessage(continuousScaleTypeMessages[value]),
  })),
)
const pageLayouts = computed(() =>
  PageLayoutValues.map((value) => ({
    value,
    title: intl.formatMessage(pageLayoutMessages[value]),
  })),
)
const paddings = computed(() =>
  PaddingPercentages.map((value) => ({
    value,
    title: value === 0 ? intl.formatMessage(messages.none) : `${value}%`,
  })),
)
const margins = computed(() =>
  PageMargins.map((value) => ({
    value,
    title: value === 0 ? intl.formatMessage(messages.none) : `${value}px`,
  })),
)
</script>
