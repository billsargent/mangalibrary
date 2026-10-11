import { describe, expect, it } from 'vitest'
import { decodeTsid, nextTsid } from './tsid.js'

describe('tsid', () => {
  it('produces 13-character Crockford Base32 ids', () => {
    for (let i = 0; i < 500; i++) {
      expect(nextTsid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/)
    }
  })

  it('is lexicographically monotonic', () => {
    const ids = Array.from({ length: 500 }, () => nextTsid())
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it('round-trips through decode', () => {
    const id = nextTsid()
    const { date, node, counter } = decodeTsid(id)
    expect(date.getTime()).toBeGreaterThanOrEqual(1577836800000)
    expect(node).toBeGreaterThanOrEqual(0)
    expect(node).toBeLessThanOrEqual(255)
    expect(counter).toBeGreaterThanOrEqual(0)
  })

  it('encodes time 0 at the epoch', () => {
    // Note: the id is not all zeros because the 8-bit node is encoded in bits 14-21.
    const id = nextTsid(1577836800000)
    const { time } = decodeTsid(id)
    expect(time).toBe(0)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/)
  })
})
