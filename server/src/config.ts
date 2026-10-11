import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Effective server configuration. */
export interface Config {
  /** Directory holding the database, logs and optional config file. */
  configDir: string
  /** Absolute path to the SQLite database file. */
  databaseFile: string
  host: string
  port: number
  logLevel: string
  sessionTtlMs: number
}

export const DEFAULT_PORT = 25600
export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_LOG_LEVEL = 'info'
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Optional config file (`config.json`) inside the config directory. */
interface FileConfig {
  databaseFile?: string
  host?: string
  port?: number
  logLevel?: string
}

function readFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FileConfig
  } catch (err) {
    throw new Error(`Invalid config file ${path}: ${(err as Error).message}`, { cause: err })
  }
}

function toNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`)
  return parsed
}

/**
 * Resolve configuration from environment variables, falling back to
 * `config.json` in the config directory, then to defaults.
 *
 * Precedence: environment > config file > defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configDir = resolve(env.KOMGA_CONFIG_DIR ?? join(homedir(), '.komga'))
  const fileConfig = readFileConfig(join(configDir, 'config.json'))

  const port = toNumber(env.SERVER_PORT ?? env.PORT, fileConfig.port ?? DEFAULT_PORT, 'port')
  const host = env.SERVER_HOST ?? fileConfig.host ?? DEFAULT_HOST
  const logLevel = env.LOG_LEVEL ?? fileConfig.logLevel ?? DEFAULT_LOG_LEVEL
  const sessionTtlMs = toNumber(env.KOMGA_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, 'session TTL')
  const databaseFile = resolve(env.KOMGA_DATABASE_FILE ?? fileConfig.databaseFile ?? join(configDir, 'database.sqlite'))

  return { configDir, databaseFile, host, port, logLevel, sessionTtlMs }
}
