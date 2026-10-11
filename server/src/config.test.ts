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
})
