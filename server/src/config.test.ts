import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST, DEFAULT_PORT, loadConfig } from './config.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ml-config-'))
}

describe('loadConfig', () => {
  it('falls back to defaults', () => {
    const config = loadConfig({ KOMGA_CONFIG_DIR: tempDir() } as NodeJS.ProcessEnv)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.host).toBe(DEFAULT_HOST)
    expect(config.logLevel).toBe('info')
    expect(config.databaseFile.endsWith('database.sqlite')).toBe(true)
  })

  it('reads environment overrides', () => {
    const config = loadConfig({
      KOMGA_CONFIG_DIR: tempDir(),
      SERVER_PORT: '8080',
      SERVER_HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
    } as NodeJS.ProcessEnv)
    expect(config.port).toBe(8080)
    expect(config.host).toBe('127.0.0.1')
    expect(config.logLevel).toBe('debug')
  })

  it('reads config.json from the config directory', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999, logLevel: 'warn' }))
    const config = loadConfig({ KOMGA_CONFIG_DIR: dir } as NodeJS.ProcessEnv)
    expect(config.port).toBe(9999)
    expect(config.logLevel).toBe('warn')
  })

  it('lets the environment win over the config file', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999 }))
    const config = loadConfig({ KOMGA_CONFIG_DIR: dir, SERVER_PORT: '1234' } as NodeJS.ProcessEnv)
    expect(config.port).toBe(1234)
  })

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ KOMGA_CONFIG_DIR: tempDir(), SERVER_PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('allows no cross-origin caller by default', () => {
    const config = loadConfig({ KOMGA_CONFIG_DIR: tempDir() } as NodeJS.ProcessEnv)
    expect(config.corsAllowedOrigins).toEqual([])
  })

  it('reads the allowed origins from the environment, trimming and dropping blanks', () => {
    const config = loadConfig({
      KOMGA_CONFIG_DIR: tempDir(),
      KOMGA_CORS_ALLOWED_ORIGINS: ' http://localhost:3000 , http://localhost:4173 ,',
    } as NodeJS.ProcessEnv)
    expect(config.corsAllowedOrigins).toEqual(['http://localhost:3000', 'http://localhost:4173'])
  })

  it('reads the allowed origins from the config file, which takes a list', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ corsAllowedOrigins: ['http://localhost:3000'] }))
    const config = loadConfig({ KOMGA_CONFIG_DIR: dir } as NodeJS.ProcessEnv)
    expect(config.corsAllowedOrigins).toEqual(['http://localhost:3000'])
  })

  it('reads books on worker threads unless they are turned off', () => {
    const dir = tempDir()
    const load = (value?: string) =>
      loadConfig({
        KOMGA_CONFIG_DIR: dir,
        ...(value === undefined ? {} : { KOMGA_WORKER_THREADS: value }),
      } as NodeJS.ProcessEnv)

    expect(load().workerThreads).toBe(true)
    expect(load('true').workerThreads).toBe(true)
    for (const off of ['false', '0', 'no', 'OFF']) expect(load(off).workerThreads).toBe(false)

    // The file is the fallback; the environment still has the last word.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ workerThreads: false }))
    expect(load().workerThreads).toBe(false)
    expect(load('true').workerThreads).toBe(true)
  })
})
