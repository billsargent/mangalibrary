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
  /** Port asked for by the environment or the config file, when one was. */
  configuredPort: number | null
  logLevel: string
  sessionTtlMs: number
  /**
   * Where the announcements feed is read from, if anywhere.
   *
   * Unset means there is no source to read, which is the honest answer for a
   * self-hosted install: the endpoint then reports that there is nothing to show
   * rather than reaching out to somebody else's website.
   */
  announcementsUrl: string | null
  /** Where release notes are read from, if anywhere. */
  releasesUrl: string | null
  /**
   * Origins allowed to call the API from a browser, empty meaning none.
   *
   * A browser refuses a cross-origin call unless the server says it may, and the
   * UI's development server is a different origin from the API by definition, so
   * this is what lets `npm run dev` in `ui/` talk to a server that is already
   * running. Production serves both from one origin and needs nothing here.
   */
  corsAllowedOrigins: string[]
  /**
   * Directory holding the fonts offered to the EPUB reader.
   *
   * Each subdirectory is a font family and its files are the faces of that family,
   * which is how an operator adds a font: drop a directory in.
   */
  fontsDir: string
  /**
   * Directory holding the built web UI, when one is named.
   *
   * Left unset here on purpose: the entrypoint falls back to the bundle built
   * beside the server, and anything else that builds a server - a test above all -
   * gets one with no UI unless it asks for it.
   */
  uiDir: string | null
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
  announcementsUrl?: string
  releasesUrl?: string
  corsAllowedOrigins?: string[]
  fontsDir?: string
  uiDir?: string
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

function toUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : resolve(trimmed)
}

/** A comma-separated list, with blanks dropped: `a, b`, `a`, and `` all work. */
function toList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (value === undefined) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
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

  const configuredPort = env.SERVER_PORT ?? env.PORT ?? fileConfig.port?.toString()
  const port = toNumber(configuredPort, DEFAULT_PORT, 'port')
  const host = env.SERVER_HOST ?? fileConfig.host ?? DEFAULT_HOST
  const logLevel = env.LOG_LEVEL ?? fileConfig.logLevel ?? DEFAULT_LOG_LEVEL
  const sessionTtlMs = toNumber(env.KOMGA_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, 'session TTL')
  const databaseFile = resolve(env.KOMGA_DATABASE_FILE ?? fileConfig.databaseFile ?? join(configDir, 'database.sqlite'))

  return {
    configDir,
    databaseFile,
    host,
    port,
    configuredPort: configuredPort === undefined || configuredPort === '' ? null : port,
    logLevel,
    sessionTtlMs,
    announcementsUrl: toUrl(env.KOMGA_ANNOUNCEMENTS_URL ?? fileConfig.announcementsUrl),
    releasesUrl: toUrl(env.KOMGA_RELEASES_URL ?? fileConfig.releasesUrl),
    corsAllowedOrigins: toList(env.KOMGA_CORS_ALLOWED_ORIGINS ?? fileConfig.corsAllowedOrigins),
    fontsDir: resolve(env.KOMGA_FONTS_DIR ?? fileConfig.fontsDir ?? join(configDir, 'fonts')),
    uiDir: toDirectory(env.KOMGA_UI_DIR ?? fileConfig.uiDir),
  }
}
