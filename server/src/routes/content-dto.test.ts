import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { filePathOf } from './content-dto.js'

describe('filePathOf', () => {
  it('gives the path a file URL names', () => {
    const path = join(process.cwd(), 'Akira', 'Volume 1 #2.cbz')
    expect(filePathOf(pathToFileURL(path).href)).toBe(path)
  })

  it('leaves a location that is not a file URL as it is', () => {
    expect(filePathOf('Akira/v1.cbz')).toBe('Akira/v1.cbz')
    expect(filePathOf('')).toBe('')
  })

  it('leaves a file URL it cannot turn into a path as it is', () => {
    // A host that is not this machine has no path here on some systems.
    const odd = 'file://%zz/broken'
    expect(filePathOf(odd)).toBe(odd)
  })
})
