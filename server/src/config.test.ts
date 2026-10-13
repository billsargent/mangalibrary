import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureWritable,
  loadConfig,
  namesDataDir,
  PROGRAM_CONFIG_NAME,
} from './config.js'

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

  it('keeps its data in a directory of its own unless told otherwise', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    expect(config.configDir.endsWith('.mangalibrary')).toBe(true)
    expect(config.databaseFile).toBe(join(config.configDir, 'database.sqlite'))
  })

  it('reads a setting by its name, and still by the name it used to have', () => {
    const current = tempDir()
    const former = tempDir()
    expect(loadConfig({ MANGALIBRARY_CONFIG_DIR: current } as NodeJS.ProcessEnv).configDir).toBe(current)
    expect(loadConfig({ KOMGA_CONFIG_DIR: former } as NodeJS.ProcessEnv).configDir).toBe(former)
    // Named both ways, the name it has now is the one meant.
    expect(
      loadConfig({ MANGALIBRARY_CONFIG_DIR: current, KOMGA_CONFIG_DIR: former } as NodeJS.ProcessEnv).configDir,
    ).toBe(current)

    expect(
      loadConfig({ MANGALIBRARY_CONFIG_DIR: current, MANGALIBRARY_WORKER_THREADS: 'false' } as NodeJS.ProcessEnv)
        .workerThreads,
    ).toBe(false)
    expect(namesDataDir({ KOMGA_CONFIG_DIR: former } as NodeJS.ProcessEnv)).toBe(true)
    expect(namesDataDir({} as NodeJS.ProcessEnv)).toBe(false)
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

describe('the config file beside the program', () => {
  const none = {} as NodeJS.ProcessEnv
  const program = (content: unknown): { folder: string; file: string } => {
    const folder = tempDir()
    const file = join(folder, PROGRAM_CONFIG_NAME)
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return { folder, file }
  }

  it('says where the data is kept, which the file inside the data cannot', () => {
    const data = tempDir()
    const { file } = program({ dataDir: data, port: 8123 })

    const config = loadConfig(none, file)
    expect(config.configDir).toBe(data)
    expect(config.databaseFile).toBe(join(data, 'database.sqlite'))
    expect(config.port).toBe(8123)
    expect(config.configFile).toBe(file)
    expect(namesDataDir(none, file)).toBe(true)
  })

  it('puts the database somewhere of its own, and reads its paths from where the file is', () => {
    const { folder, file } = program({ dataDir: 'data', databaseFile: 'db/library.sqlite' })

    const config = loadConfig(none, file)
    expect(config.configDir).toBe(join(folder, 'data'))
    expect(config.databaseFile).toBe(join(folder, 'db', 'library.sqlite'))
  })

  it('gives way to the environment, and wins over the file in the data folder', () => {
    const data = tempDir()
    writeFileSync(join(data, 'config.json'), JSON.stringify({ port: 1111, logLevel: 'warn', host: '127.0.0.1' }))
    const { file } = program({ dataDir: data, port: 2222, logLevel: 'debug' })

    const config = loadConfig({ SERVER_PORT: '3333' } as NodeJS.ProcessEnv, file)
    expect(config.port).toBe(3333)
    expect(config.logLevel).toBe('debug')
    // What only the file in the data folder says is still read.
    expect(config.host).toBe('127.0.0.1')

    const elsewhere = tempDir()
    expect(loadConfig({ MANGALIBRARY_CONFIG_DIR: elsewhere } as NodeJS.ProcessEnv, file).configDir).toBe(elsewhere)
  })

  it('is not looked for unless a place is given, and need not be there', () => {
    expect(loadConfig(none).configFile).toBeNull()
    expect(loadConfig(none, join(tempDir(), PROGRAM_CONFIG_NAME)).configFile).toBeNull()
    expect(namesDataDir(none, join(tempDir(), PROGRAM_CONFIG_NAME))).toBe(false)
  })

  it('can be named, and then has to exist', () => {
    const data = tempDir()
    const { file } = program({ dataDir: data })
    const named = { MANGALIBRARY_CONFIG_FILE: file } as NodeJS.ProcessEnv

    expect(loadConfig(named).configDir).toBe(data)
    expect(() => loadConfig({ MANGALIBRARY_CONFIG_FILE: join(data, 'missing.json') } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    )
  })

  it('says so in a sentence when it is not valid', () => {
    const { file } = program('{ "port": 8080, }')
    expect(() => loadConfig(none, file)).toThrow(ConfigError)
    expect(() => loadConfig(none, file)).toThrow(/is not valid JSON/)
  })
})

describe('a place for the database', () => {
  it('is made when it is not there', () => {
    const databaseFile = join(tempDir(), 'new', 'folder', 'database.sqlite')
    ensureWritable({ databaseFile })
    expect(existsSync(join(databaseFile, '..'))).toBe(true)
  })

  it('is refused in a sentence when it cannot be used', () => {
    // A file where a folder would have to be: nothing can be created under it.
    const blocker = join(tempDir(), 'not-a-folder')
    writeFileSync(blocker, 'in the way')
    const databaseFile = join(blocker, 'database.sqlite')

    expect(() => ensureWritable({ databaseFile })).toThrow(ConfigError)
    expect(() => ensureWritable({ databaseFile })).toThrow(/The database cannot be kept at/)
  })
})
