/**
 * The events the server pushes to connected clients.
 *
 * The names are the ones the browser UI listens for, so they are part of the
 * contract even though they never appear in the OpenAPI document.
 */
export type SseEventName =
  | 'LibraryAdded'
  | 'LibraryChanged'
  | 'LibraryDeleted'
  | 'SeriesAdded'
  | 'SeriesChanged'
  | 'SeriesDeleted'
  | 'BookAdded'
  | 'BookChanged'
  | 'BookDeleted'
  | 'BookImported'
  | 'ReadListAdded'
  | 'ReadListChanged'
  | 'ReadListDeleted'
  | 'CollectionAdded'
  | 'CollectionChanged'
  | 'CollectionDeleted'
  | 'ReadProgressChanged'
  | 'ReadProgressDeleted'
  | 'ReadProgressSeriesChanged'
  | 'ReadProgressSeriesDeleted'
  | 'ThumbnailBookAdded'
  | 'ThumbnailBookDeleted'
  | 'ThumbnailSeriesAdded'
  | 'ThumbnailSeriesDeleted'
  | 'ThumbnailSeriesCollectionAdded'
  | 'ThumbnailSeriesCollectionDeleted'
  | 'ThumbnailReadListAdded'
  | 'ThumbnailReadListDeleted'
  | 'TaskQueueStatus'
  | 'SessionExpired'

export interface SseEvent {
  name: SseEventName
  data: unknown
  /** Only administrators see this event. */
  adminOnly?: boolean
  /** Only this user sees this event. */
  userId?: string
}

export type SseListener = (event: SseEvent) => void

/**
 * In-process fan-out from a route that changed something to the connections
 * watching for it.
 *
 * A listener is a connection handler, and it runs inside the request that
 * published the event: one that throws (a client that vanished mid-write) must
 * not fail that request, so publishing swallows and reports.
 */
export class EventBus {
  private readonly listeners = new Set<SseListener>()

  subscribe(listener: SseListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  publish(event: SseEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken listener is dropped by its own connection handler.
      }
    }
  }
}
