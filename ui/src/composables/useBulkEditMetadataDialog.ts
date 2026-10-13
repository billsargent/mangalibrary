import { storeToRefs } from 'pinia'
import { useIntl } from 'vue-intl'
import { useDisplay } from 'vuetify/framework'
import { clearAllBooks, clearAllSeries } from '@/colada/cache'
import BookBulkEdit from '@/components/book/form/BulkEdit.vue'
import SeriesBulkEdit from '@/components/series/form/BulkEdit.vue'
import {
  bulkBookPatches,
  bulkPatch,
  emptyBookBulkForm,
  emptySeriesBulkForm,
} from '@/functions/bulk-metadata'
import {
  komgaUpdateBookMetadataByBatch,
  komgaUpdateSeriesMetadata,
  type BookDto,
  type SeriesDto,
} from '@/generated/openapi'
import { type DialogResult, useDialogsStore } from '@/stores/dialogs'
import { useMessagesStore } from '@/stores/messages'
import { commonMessages } from '@/utils/i18n/common-messages'

/**
 * The dialog that edits several series, or several books, at once.
 *
 * Books go to the server in one request, which has an endpoint for it. Series have
 * none, so each is updated in turn, as the legacy interface does it.
 */
export function useBulkEditMetadataDialog() {
  const { confirmEdit: dialogConfirmEdit } = storeToRefs(useDialogsStore())
  const intl = useIntl()
  const display = useDisplay()
  const messagesStore = useMessagesStore()

  function prepare(
    title: string,
    count: number,
    component: object,
    record: object,
    save: (patch: Record<string, unknown>) => Promise<unknown>,
    callback: () => void,
  ) {
    dialogConfirmEdit.value.dialogProps = {
      title,
      subtitle: intl.formatMessage(
        {
          description: 'Bulk edit metadata dialog: subtitle, how many items are being edited',
          defaultMessage: '{count, plural, one {# item} other {# items}}',
          id: 'pNNU6x',
        },
        { count },
      ),
      maxWidth: 800,
      closeOnSave: false,
      scrollable: true,
      fullscreen: display.xs.value,
    }
    dialogConfirmEdit.value.slot = { component: markRaw(component) }
    dialogConfirmEdit.value.record = record
    dialogConfirmEdit.value.callback = async (
      result: DialogResult,
      hideDialog: () => void,
      setLoading: (isLoading: boolean) => void,
    ) => {
      if (result === 'cancel') {
        callback()
        return
      }

      const patch = bulkPatch(dialogConfirmEdit.value.record as object)
      // Nothing filled in is nothing to do, and no reason to tell the server.
      if (Object.keys(patch).length === 0) {
        hideDialog()
        callback()
        return
      }

      setLoading(true)
      try {
        await save(patch)
        hideDialog()
        messagesStore.messages.push({
          message: intl.formatMessage(
            {
              description: 'Snackbar notification shown after several items were edited at once',
              defaultMessage: '{count, plural, one {# item} other {# items}} updated',
              id: 'jBHrge',
            },
            { count },
          ),
        })
        callback()
      } catch (error) {
        const cause = (error as { cause?: { message?: string } } | undefined)?.cause
        messagesStore.messages.push(
          cause?.message ? { message: cause.message } : commonMessages.networkError,
        )
        setLoading(false)
      }
    }
  }

  const prepareSeries = (series: SeriesDto[], callback: () => void = () => {}) =>
    prepare(
      intl.formatMessage({
        description: 'Bulk edit series metadata dialog title',
        defaultMessage: 'Edit series metadata',
        id: 'ZwnGaE',
      }),
      series.length,
      SeriesBulkEdit,
      emptySeriesBulkForm(),
      async (patch) => {
        for (const item of series) {
          await komgaUpdateSeriesMetadata({ path: { seriesId: item.id }, body: patch })
        }
        clearAllSeries()
      },
      callback,
    )

  const prepareBooks = (books: BookDto[], callback: () => void = () => {}) =>
    prepare(
      intl.formatMessage({
        description: 'Bulk edit book metadata dialog title',
        defaultMessage: 'Edit book metadata',
        id: '1zneF6',
      }),
      books.length,
      BookBulkEdit,
      emptyBookBulkForm(),
      async (patch) => {
        await komgaUpdateBookMetadataByBatch({
          body: bulkBookPatches(
            books.map((book) => book.id),
            patch,
          ),
        })
        clearAllBooks()
      },
      callback,
    )

  const activator = computed({
    get: () => dialogConfirmEdit.value.activator,
    set: (value) => (dialogConfirmEdit.value.activator = value),
  })

  return { prepareSeries, prepareBooks, activator }
}
