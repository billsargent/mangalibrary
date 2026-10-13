import { describe, expect, test } from 'vitest'
import { bulkBookPatches, bulkPatch, emptyBookBulkForm, emptySeriesBulkForm } from './bulk-metadata'

describe('bulkPatch', () => {
  test('asks for nothing when nothing was filled in', () => {
    expect(bulkPatch(emptySeriesBulkForm())).toEqual({})
    expect(bulkPatch(emptyBookBulkForm())).toEqual({})
  })

  test('takes the filled fields, and locks each one', () => {
    const form = emptySeriesBulkForm()
    form.status = 'ENDED'
    form.ageRating = 16
    form.genres = ['Drama']

    expect(bulkPatch(form)).toEqual({
      status: 'ENDED',
      statusLock: true,
      ageRating: 16,
      ageRatingLock: true,
      genres: ['Drama'],
      genresLock: true,
    })
  })

  test('counts a rating of zero as filled, and spaces as empty', () => {
    const form = emptySeriesBulkForm()
    form.ageRating = 0
    form.publisher = '   '
    form.language = ' fr '

    expect(bulkPatch(form)).toEqual({
      ageRating: 0,
      ageRatingLock: true,
      language: 'fr',
      languageLock: true,
    })
  })

  test('takes the authors and tags of a book form', () => {
    const form = emptyBookBulkForm()
    form.authors = [{ name: 'Katsuhiro Otomo', role: 'writer' }]

    expect(bulkPatch(form)).toEqual({
      authors: [{ name: 'Katsuhiro Otomo', role: 'writer' }],
      authorsLock: true,
    })
  })
})

describe('bulkBookPatches', () => {
  test('gives every book the same update', () => {
    const patch = { tags: ['classic'], tagsLock: true }
    expect(bulkBookPatches(['B1', 'B2'], patch)).toEqual({ B1: patch, B2: patch })
  })
})
