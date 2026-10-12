import { useBook } from '@/composables/book/useBook'
import { bookReaderRoute } from '@/api/links'
import { useMessagesStore } from '@/stores/messages'
import { type ReadListDto, type SeriesDto } from '@/generated/openapi'
import { isReadList } from '@/functions/entity'
import { getFirstBookInParent } from '@/functions/book-container'

/**
 * Provide functions to retrieve books from either a series or a read list
 * @param parent a SeriesDto, ReadListDto
 */
export function useBooks(parent: MaybeRefOrGetter<SeriesDto | ReadListDto>) {
  const messagesStore = useMessagesStore()
  const router = useRouter()

  async function readFirstBook(incognito: boolean = false) {
    let book = await getFirstBookInParent(toValue(parent), true)
    if (book === undefined) {
      book = await getFirstBookInParent(toValue(parent), false)
    }
    if (book) {
      const { canRead, isEpubReader } = useBook(book)
      if (canRead.value) {
        const parentValue = toValue(parent)
        void router.push(
          bookReaderRoute(
            book.id,
            isEpubReader.value,
            incognito,
            isReadList(parentValue) ? parentValue.id : undefined,
          ),
        )
      } else {
        messagesStore.messages.push({
          message: {
            description: 'Notification: no readable book found for series',
            defaultMessage: 'Series does not have any readable book',
            id: 'p+98v0',
          },
        })
      }
    }
  }

  return {
    readFirstBook,
  }
}
