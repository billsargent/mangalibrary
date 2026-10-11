import { describe, expect, it } from 'vitest'
import { TransientBookStore, type TransientBook } from './transient.js'

function book(id: string): TransientBook {
  return {
    id,
    name: 'Volume 1',
    path: `/books/${id}.cbz`,
    fileSize: 10,
    fileLastModified: new Date(0),
    lastModified: new Date(0),
    status: 'UNKNOWN',
    mediaType: null,
    pages: [],
    files: [],
    comment: null,
  }
}

describe('transient book store', () => {
  it('forgets a book once it has been idle for the hour', () => {
    let now = 0
    const store = new TransientBookStore(1000, () => now)
    store.save(book('A'))

    // It lives for an hour from the last access, so each read below pushes the
    // moment it is forgotten further out.
    now = 999
    expect(store.get('A')).toBeDefined()

    now = 1998
    expect(store.get('A')).toBeDefined()

    now = 2998
    expect(store.get('A')).toBeUndefined()
  })

  it('returns undefined for an id it never saw', () => {
    expect(new TransientBookStore().get('missing')).toBeUndefined()
  })

  it('replaces a book that is saved again', () => {
    const store = new TransientBookStore()
    store.save(book('A'))
    store.save({ ...book('A'), status: 'READY' })
    expect(store.get('A')?.status).toBe('READY')
  })
})
