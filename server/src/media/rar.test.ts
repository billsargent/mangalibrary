import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { writeRar } from '../testing/rar.js'
import { openRar } from './rar.js'

const sample = (name: string): Buffer => readFileSync(new URL(`../testing/fixtures/rar/${name}`, import.meta.url))

describe('reading archives written by the real compressor', () => {
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

  it('reads what is not encrypted and refuses what is', async () => {
    const archive = await openRar(sample('FileEncByName.rar'))

    expect((await archive.read('1File.txt')).toString()).toBe('1File')
    await expect(archive.read('3Sec.txt')).rejects.toThrow(/[Pp]assword/)
    // A refusal does not spoil the archive for the next read.
    expect((await archive.read('1File.txt')).toString()).toBe('1File')
  })

  it('refuses an archive it cannot even list', async () => {
    await expect(openRar(sample('HeaderEnc1234.rar'))).rejects.toThrow(/[Pp]assword/)
    await expect(openRar(Buffer.from('not a rar archive'))).rejects.toThrow()
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

  it('takes plain names only, since that is all it knows how to write', () => {
    expect(() => writeRar([{ name: '中文.jpg', data: page }])).toThrow('ASCII')
  })
})
