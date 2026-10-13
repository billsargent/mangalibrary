import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { writeRar } from '../testing/rar.js'
import { openRar } from './rar.js'

const samplePath = (name: string): string => fileURLToPath(new URL(`../testing/fixtures/rar/${name}`, import.meta.url))

// An archive is read from disk when the server has a path, and from memory when it
// has only bytes. Both are the same reader and must agree.
describe.each([
  ['from disk', (name: string): string | Buffer => samplePath(name)],
  ['from memory', (name: string): string | Buffer => readFileSync(samplePath(name))],
])('reading archives written by the real compressor, %s', (_where, sample) => {
  it('lists what is inside, with sizes, and leaves folders out', async () => {
    const archive = await openRar(sample('FolderTest.rar'))

    expect(archive.entries).toEqual(['Folder1/Folder Space/long.txt', 'Folder1/Folder 中文/2中文.txt'])
    expect(archive.sizes.get('Folder1/Folder Space/long.txt')).toBe(1_049_076)
    expect(archive.sizes.get('Folder1/Folder 中文/2中文.txt')).toBe(15)
  })

  it('reads an entry by name, compressed or not, more than once and in any order', async () => {
    const archive = await openRar(sample('FolderTest.rar'))

    const small = await archive.read('Folder1/Folder 中文/2中文.txt')
    expect(small.toString('utf8')).toContain('中文中文')

    // A megabyte that the archive holds in five kilobytes.
    const long = await archive.read('Folder1/Folder Space/long.txt')
    expect(long).toHaveLength(1_049_076)
    expect(long.subarray(0, 10).toString()).toBe('1101001000')

    expect((await archive.read('Folder1/Folder 中文/2中文.txt')).equals(small)).toBe(true)
  })

  it('reads an empty file as nothing', async () => {
    const archive = await openRar(sample('WithComment.rar'))
    expect(archive.entries).toEqual(['1File.txt', '2中文.txt'])
    expect(await archive.read('1File.txt')).toHaveLength(0)
  })

  it('refuses an archive with anything encrypted in it, as the reference does', async () => {
    // Some of this one's files can be read without a password. A comic that is
    // partly locked is not a comic that can be read, so the whole of it is refused.
    await expect(openRar(sample('FileEncByName.rar'))).rejects.toMatchObject({ code: 'ERR_1002', unsupported: true })

    // A refusal does not spoil the unpacker for the next archive.
    const next = await openRar(sample('WithComment.rar'))
    expect(next.entries).toEqual(['1File.txt', '2中文.txt'])
  })

  it('refuses an archive it cannot even list', async () => {
    await expect(openRar(sample('HeaderEnc1234.rar'))).rejects.toMatchObject({ code: 'ERR_1002', unsupported: true })
    await expect(openRar(Buffer.from('not a rar archive'))).rejects.toThrow()
    await expect(openRar(join(tmpdir(), 'no-such-archive.rar'))).rejects.toThrow()
  })

  it('keeps two open archives apart', async () => {
    // The unpacker is shared by everything on a thread, and answers to one archive
    // at a time.
    const first = await openRar(sample('FolderTest.rar'))
    const second = await openRar(writeRar([{ name: '1File.txt', data: Buffer.from('1File') }]))

    expect((await first.read('Folder1/Folder 中文/2中文.txt')).toString('utf8')).toContain('中文中文')
    expect((await second.read('1File.txt')).toString()).toBe('1File')
    expect(await first.read('Folder1/Folder Space/long.txt')).toHaveLength(1_049_076)
    expect((await second.read('1File.txt')).toString()).toBe('1File')
  })

  it('says so when asked for an entry that is not there', async () => {
    const archive = await openRar(sample('FolderTest.rar'))
    await expect(archive.read('nothing.txt')).rejects.toThrow('cannot read nothing.txt')
  })
})

describe('an archive built for a test', () => {
  const page = Buffer.from('a page, as far as an archive is concerned')

  it('is read back as it was written', async () => {
    const archive = await openRar(
      writeRar([
        { name: 'page 01.jpg', data: page },
        { name: 'extras/page 02.jpg', data: Buffer.concat([page, page]) },
        { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
      ]),
    )

    expect(archive.entries).toEqual(['page 01.jpg', 'extras/page 02.jpg', 'ComicInfo.xml'])
    expect(archive.sizes.get('extras/page 02.jpg')).toBe(page.length * 2)
    expect((await archive.read('page 01.jpg')).equals(page)).toBe(true)
    expect((await archive.read('ComicInfo.xml')).toString()).toBe('<ComicInfo/>')
    expect((await archive.read('extras/page 02.jpg')).equals(Buffer.concat([page, page]))).toBe(true)
  })

  it('is read from disk without what it unpacks being written anywhere', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ml-rar-'))
    const path = join(folder, 'book.cbr')
    writeFileSync(path, writeRar([{ name: 'extras/page 02.jpg', data: page }]))

    const archive = await openRar(path)
    expect((await archive.read('extras/page 02.jpg')).equals(page)).toBe(true)
    // The library's own way of reading from disk unpacks into the working folder.
    expect(() => readFileSync(join(process.cwd(), 'extras', 'page 02.jpg'))).toThrow()
    expect(() => readFileSync(join(folder, 'extras', 'page 02.jpg'))).toThrow()
  })

  it('takes plain names only, since that is all it knows how to write', () => {
    expect(() => writeRar([{ name: '中文.jpg', data: page }])).toThrow('ASCII')
  })
})
