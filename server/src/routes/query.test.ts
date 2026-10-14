import { describe, expect, it } from 'vitest'
import { isRegex, MAX_REGEX_LENGTH } from './query.js'

describe('isRegex', () => {
  it('accepts the patterns a search is made of', () => {
    const accepted = [
      'one piece',
      '^a.*z$',
      '(ab)+',
      String.raw`[a-z]+ \d{2,3}`,
      String.raw`vol(ume)?\.? ?\d+`,
      '(a|b)*c',
    ]
    for (const pattern of accepted) {
      expect([pattern, isRegex(pattern)]).toEqual([pattern, true])
    }
  })

  it('refuses one that is invalid, too long, or can run for ever', () => {
    const refused = [
      '(unclosed',
      '(a+)+',
      String.raw`(\w*)*`,
      String.raw`(?:\d+\s?)+$`,
      '((ab)+)+',
      String.raw`(.)\1`,
      'x'.repeat(MAX_REGEX_LENGTH + 1),
    ]
    for (const pattern of refused) {
      expect([pattern.slice(0, 20), isRegex(pattern)]).toEqual([pattern.slice(0, 20), false])
    }
  })
})
