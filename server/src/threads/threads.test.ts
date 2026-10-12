import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { writeZip } from '../testing/zip.js'
import { onThread, startThreads, stopThreads, threadsStarted } from './index.js'

async function book(): Promise<{ path: string; page: Buffer }> {
  const page = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#336699' } })
    .png()
    .toBuffer()
  const path = join(mkdtempSync(join(tmpdir(), 'ml-threads-')), 'book.cbz')
  writeFileSync(
    path,
    writeZip([
      { name: '01.png', data: page },
      { name: '02.png', data: page },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>On a thread</Title></ComicInfo>') },
    ]),
  )
  return { path, page }
}

afterEach(async () => {
  await stopThreads()
})

describe('worker threads', () => {
  it('runs a task in place until the threads are started', async () => {
    expect(threadsStarted()).toBe(false)
    expect((await onThread('whichThread', {})).main).toBe(true)
  })

  it('runs a task on a thread of its own once they are', async () => {
    startThreads({ maxThreads: 2 })
    expect(threadsStarted()).toBe(true)

    const where = await onThread('whichThread', {})
    expect(where.main).toBe(false)
    expect(where.id).toBeGreaterThan(0)
  })

  it('gives the same answers on a thread as in place', async () => {
    const { path, page } = await book()

    const inPlace = {
      inspection: await onThread('inspect', { path, options: { analyzeDimensions: true } }),
      documents: await onThread('documents', { path }),
      fileHash: await onThread('hashFile', { path }),
      koreader: await onThread('hashKoreader', { path }),
      pages: await onThread('hashPages', { path, pages: [2, 1] }),
      barcode: await onThread('barcode', { path }),
    }
    expect(inPlace.inspection.status).toBe('READY')
    expect(inPlace.inspection.pages.map((entry) => [entry.fileName, entry.width, entry.height])).toEqual([
      ['01.png', 30, 40],
      ['02.png', 30, 40],
    ])

    startThreads({ maxThreads: 2 })
    expect(await onThread('inspect', { path, options: { analyzeDimensions: true } })).toEqual(inPlace.inspection)
    expect(await onThread('documents', { path })).toEqual(inPlace.documents)
    expect(await onThread('hashFile', { path })).toBe(inPlace.fileHash)
    expect(await onThread('hashKoreader', { path })).toBe(inPlace.koreader)
    expect(await onThread('hashPages', { path, pages: [2, 1] })).toEqual(inPlace.pages)
    expect(await onThread('barcode', { path })).toEqual(inPlace.barcode)

    // A poster's bytes survive the crossing.
    const poster = await onThread('poster', { path })
    expect(poster?.mediaType).toBe('image/png')
    expect(Buffer.from(poster!.bytes).equals(page)).toBe(true)
  })

  it('reports a book it cannot read rather than failing the task', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ml-threads-')), 'broken.cbz')
    writeFileSync(path, 'not an archive')

    startThreads({ maxThreads: 1 })
    expect((await onThread('inspect', { path })).status).toBe('ERROR')
    expect((await onThread('documents', { path })).status).toBe('failed')
    expect(await onThread('poster', { path })).toBeNull()
  })

  it('passes on the failure of a task that does fail', async () => {
    startThreads({ maxThreads: 1 })
    await expect(onThread('hashFile', { path: join(tmpdir(), 'ml-threads-missing.cbz') })).rejects.toThrow()
  })

  it('runs several tasks at once on several threads', async () => {
    startThreads({ maxThreads: 3 })
    const seen = await Promise.all([
      onThread('whichThread', {}),
      onThread('whichThread', {}),
      onThread('whichThread', {}),
    ])
    expect(seen.every((where) => !where.main)).toBe(true)
  })

  it('runs in place again once the threads are stopped', async () => {
    startThreads({ maxThreads: 1 })
    await onThread('whichThread', {})
    await stopThreads()

    expect(threadsStarted()).toBe(false)
    expect((await onThread('whichThread', {})).main).toBe(true)
  })
})
