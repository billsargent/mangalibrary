import { describe, expect, it } from 'vitest'
import { mylarSeriesPatch, MYLAR_AGE_RATINGS } from './sidecar.js'

function sidecar(metadata: Record<string, unknown>): string {
  return JSON.stringify({ metadata })
}

describe('reading a Mylar series.json', () => {
  it('takes the name, the publisher, the summary, the status and the issue count', () => {
    const patch = mylarSeriesPatch(
      sidecar({
        name: 'Akira',
        publisher: 'Kodansha',
        year: 1984,
        volume: 1,
        description_text: 'Neo-Tokyo.',
        description_formatted: '<p>Neo-Tokyo.</p>',
        status: 'Continuing',
        total_issues: 6,
        age_rating: '17+',
      }),
    )

    expect(patch).toEqual({
      title: 'Akira',
      titleSort: 'Akira',
      publisher: 'Kodansha',
      summary: '<p>Neo-Tokyo.</p>',
      status: 'ONGOING',
      totalBookCount: 6,
      ageRating: 17,
    })
  })

  it('appends the year once the collection has more than one volume', () => {
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', year: 1984, volume: 2 }))?.title).toBe('Akira (1984)')
    // Volume 1 is the series itself, and a collection without a volume is too.
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', year: 1984, volume: 1 }))?.title).toBe('Akira')
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', year: 1984 }))?.title).toBe('Akira')
    // A volume with no year to tell it apart is left as the name.
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', volume: 2 }))?.title).toBe('Akira')
  })

  it('reads a status Mylar writes and ignores one it does not', () => {
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', status: 'Ended' }))?.status).toBe('ENDED')
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', status: 'Continuing' }))?.status).toBe('ONGOING')
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', status: 'Cancelled' }))?.status).toBeUndefined()
  })

  it('prefers the formatted description and falls back to the plain one', () => {
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', description_text: 'Plain' }))?.summary).toBe('Plain')
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', description_formatted: '  ' }))?.summary).toBeUndefined()
    expect(
      mylarSeriesPatch(sidecar({ name: 'Akira', description_formatted: '', description_text: 'Plain' }))?.summary,
    ).toBe('Plain')
  })

  it('reads the age rating Mylar writes, and leaves alone one it does not', () => {
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', age_rating: 'Adult' }))?.ageRating).toBe(18)
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', age_rating: '9+' }))?.ageRating).toBe(9)
    expect(mylarSeriesPatch(sidecar({ name: 'Akira', age_rating: 'Everyone' }))?.ageRating).toBeUndefined()
    expect([...MYLAR_AGE_RATINGS.keys()]).toEqual(['all', '9+', '12+', '15+', '17+', 'adult'])
  })

  it('reads a blank field as one the document does not carry', () => {
    const patch = mylarSeriesPatch(sidecar({ name: '  ', publisher: '', total_issues: 0 }))
    expect(patch).toEqual({ totalBookCount: 0 })
  })

  it('says nothing about a document it cannot read', () => {
    expect(mylarSeriesPatch('not json at all')).toBeNull()
    expect(mylarSeriesPatch('[]')).toBeNull()
    expect(mylarSeriesPatch(JSON.stringify({ metadata: null }))).toBeNull()
    // A document without the metadata object is not a Mylar sidecar.
    expect(mylarSeriesPatch(JSON.stringify({ name: 'Akira' }))).toBeNull()
  })
})
