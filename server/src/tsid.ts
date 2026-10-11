/**
 * TSID — time-sortable unique IDs, byte-compatible with Komga's `tsid-creator`.
 *
 * Layout (64 bits): 42-bit milliseconds since 2020-01-01T00:00:00Z | 8-bit node | 14-bit counter.
 * Encoding: 13 characters of Crockford Base32 (uppercase, case-insensitive, URL-safe).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const EPOCH = 1577836800000 // 2020-01-01T00:00:00Z

const MAX_TIME = (1n << 42n) - 1n
const MAX_NODE = 255
const COUNTER_MASK = 0x3fffn // 14 bits

const node: number = (() => {
  const fromEnv = process.env.TSID_NODE ?? process.env.tsidcreator_node
  if (fromEnv !== undefined) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_NODE) return parsed
  }
  return Math.floor(Math.random() * (MAX_NODE + 1))
})()

let counter = 0
let lastTime = -1n

function encode(value: bigint): string {
  let out = ''
  for (let i = 0; i < 13; i++) {
    out = ALPHABET[Number(value & 0x1fn)]! + out
    value >>= 5n
  }
  return out
}

/** Generate a new TSID string. */
export function nextTsid(now: number = Date.now()): string {
  let time = BigInt(now - EPOCH)
  if (time > MAX_TIME) throw new Error('TSID time overflow')

  if (time === lastTime) {
    counter = (counter + 1) & COUNTER_MASK
    if (counter === 0) {
      // Counter exhausted within this millisecond: wait for the next one.
      while (BigInt(Date.now() - EPOCH) <= lastTime) {
        /* spin */
      }
      time = BigInt(Date.now() - EPOCH)
    }
  } else {
    counter = 0
  }
  lastTime = time

  const value = (time << 22n) | (BigInt(node) << 14n) | BigInt(counter)
  return encode(value)
}

/** Decode a TSID string back to its parts (useful for tests/diagnostics). */
export function decodeTsid(tsid: string): { time: number; node: number; counter: number; date: Date } {
  if (tsid.length !== 13) throw new Error(`Invalid TSID length: ${tsid.length}`)
  let value = 0n
  for (const ch of tsid.toUpperCase()) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error(`Invalid TSID character: ${ch}`)
    value = (value << 5n) | BigInt(idx)
  }
  const counterVal = Number(value & 0x3fffn)
  const nodeVal = Number((value >> 14n) & 0xffn)
  const timeVal = value >> 22n
  return { time: Number(timeVal), node: nodeVal, counter: counterVal, date: new Date(Number(timeVal) + EPOCH) }
}
