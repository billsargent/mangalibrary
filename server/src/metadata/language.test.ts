import { describe, expect, it } from 'vitest'
import { normalisedLanguage } from './language.js'

describe('normalising a language tag', () => {
  it('takes a language on its own', () => {
    expect(normalisedLanguage('en')).toBe('en')
    expect(normalisedLanguage('EN')).toBe('en')
    expect(normalisedLanguage(' fre ')).toBe('fre')
  })

  it('normalises the casing of the parts after it', () => {
    expect(normalisedLanguage('en-us')).toBe('en-US')
    expect(normalisedLanguage('pt_br')).toBe('pt-BR')
    expect(normalisedLanguage('zh-hans')).toBe('zh-Hans')
    expect(normalisedLanguage('sl-rozaj-biske')).toBe('sl-rozaj-biske')
  })

  it('refuses what is not a tag', () => {
    expect(normalisedLanguage('Unknown')).toBeNull()
    expect(normalisedLanguage('')).toBeNull()
    expect(normalisedLanguage('  ')).toBeNull()
    expect(normalisedLanguage(null)).toBeNull()
    expect(normalisedLanguage('english')).toBeNull()
    expect(normalisedLanguage('e')).toBeNull()
  })
})
