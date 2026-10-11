import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Readable } from 'node:stream'
import yauzl from 'yauzl'
import { describe, expect, it } from 'vitest'
import { zipStream } from './zip.js'

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Read a ZIP back with an independent reader, to check what was written. */
function readZip(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('not a zip'))
        return
      }

      const entries: { name: string; data: Buffer }[] = []
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('cannot read entry'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) })
            zipfile.readEntry()
          })
          stream.on('error', reject)
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

function tempFile(name: string, data: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'ml-zip-'))
  const path = join(root, name)
  writeFileSync(path, data)
  return path
}

describe('zip writer', () => {
  it('writes files a standard reader can read back', async () => {
    const first = Buffer.from('first book bytes')
    const second = Buffer.from('second book, a little longer than the other one')

    const archive = await collect(
      zipStream([
        { name: 'one.cbz', path: tempFile('one.cbz', first) },
        { name: 'two.cbz', path: tempFile('two.cbz', second) },
      ]),
    )

    const entries = await readZip(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['one.cbz', 'two.cbz'])
    expect(entries[0]?.data.equals(first)).toBe(true)
    expect(entries[1]?.data.equals(second)).toBe(true)
  })

  it('keeps a non-ASCII name, and handles an empty file', async () => {
    const archive = await collect(
      zipStream([
        { name: 'Tome 1 — début.cbz', path: tempFile('a.cbz', Buffer.from('x')) },
        { name: 'empty.cbz', path: tempFile('b.cbz', Buffer.alloc(0)) },
      ]),
    )

    const entries = await readZip(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['Tome 1 — début.cbz', 'empty.cbz'])
    expect(entries[1]?.data.length).toBe(0)
  })

  it('writes an archive with no entries', async () => {
    const archive = await collect(zipStream([]))
    expect(await readZip(archive)).toEqual([])
  })
})
