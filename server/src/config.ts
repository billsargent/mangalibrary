import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDataDir } from './data-dir.js'

/** Effective server configuration. */
export interface Config {
  /** Directory holding the database, logs and optional config file. */
  configDir: string
  /** The config file beside the program that was read, or null when there was none. */
  configFile: string | null
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
   * Whether the client address and protocol a proxy reports (`X-Forwarded-For`,
   * `X-Forwarded-Proto`) are believed. Off unless the server is behind a proxy that
   * sets them: believed from anybody, they let a client choose its own address, and
   * with it walk around the limit on failed sign-ins.
   */
  trustProxy: boolean
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
  /**
   * Whether a book's file is read on worker threads.
   *
   * On unless it is turned off, which is there for a machine too small to want
   * them: with it off the same work runs on the main thread, one piece at a time.
   */
  workerThreads: boolean
}

export const DEFAULT_PORT = 25600
export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_LOG_LEVEL = 'info'
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What a config file may say. There are two: `mangalibrary.json` beside the
 * program, and `config.json` inside the data directory. Only the first can say
 * where the data directory is, since the second is in it.
 */
interface FileConfig {
  /** Where the data is kept. Read from the file beside the program only. */
  dataDir?: string
  databaseFile?: string
  host?: string
  port?: number
  logLevel?: string
  announcementsUrl?: string
  releasesUrl?: string
  corsAllowedOrigins?: string[]
  trustProxy?: boolean
  fontsDir?: string
  uiDir?: string
  workerThreads?: boolean
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

/** A switch from the environment: off for "false", "0", "no" or "off", on for anything else set. */
function toSwitch(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())
}

/**
 * A setting from the environment, by the name it has now or the name it had.
 *
 * The settings were first named after Komga (`KOMGA_CONFIG_DIR`). They are named
 * after this project now, and the old names are still read so that a setup
 * written for an earlier version goes on starting. The new name wins.
 */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`MANGALIBRARY_${name}`] ?? env[`KOMGA_${name}`]
}

/** The name of the config file that is looked for beside the program. */
export const PROGRAM_CONFIG_NAME = 'mangalibrary.json'

/**
 * Where the config file beside the program would be: the folder holding
 * `server/`, which is the folder that was cloned. Seen from this file in `src/`
 * or in `dist/`.
 */
export function programConfigFile(): string {
  return fileURLToPath(new URL(`../../${PROGRAM_CONFIG_NAME}`, import.meta.url))
}

/**
 * A problem with the configuration that the person starting the server can fix.
 * Shown as a sentence, where anything else is shown with where it came from.
 */
export class ConfigError extends Error {}

/**
 * The config file beside the program: the one `MANGALIBRARY_CONFIG_FILE` names,
 * or the one at `programFile` when the caller gives a place to look. A file that
 * is named and is not there is a mistake worth stopping for; the default one
 * simply may not exist.
 *
 * A path in it is relative to the file, not to wherever the server was started
 * from, so the same file means the same thing however it is started.
 */
function readProgramConfig(
  env: NodeJS.ProcessEnv,
  programFile: string | null,
): { file: string | null; config: FileConfig } {
  const named = setting(env, 'CONFIG_FILE')
  const file = named !== undefined && named.trim() !== '' ? resolve(named.trim()) : programFile
  if (file === null) return { file: null, config: {} }
  if (!existsSync(file)) {
    if (named !== undefined && named.trim() !== '') throw new ConfigError(`The config file ${file} does not exist.`)
    return { file: null, config: {} }
  }

  let config: FileConfig
  try {
    config = readFileConfig(file)
  } catch (error) {
    throw new ConfigError(`The config file ${file} is not valid JSON: ${((error as Error).cause as Error).message}`)
  }
  const folder = dirname(file)
  for (const key of ['dataDir', 'databaseFile', 'fontsDir', 'uiDir'] as const) {
    const value = config[key]
    if (typeof value === 'string' && value.trim() !== '') config[key] = resolve(folder, value.trim())
  }
  return { file, config }
}

/** Whether the data directory is named, by the environment or by the config file beside the program. */
export function namesDataDir(env: NodeJS.ProcessEnv = process.env, programFile: string | null = null): boolean {
  return setting(env, 'CONFIG_DIR') !== undefined || readProgramConfig(env, programFile).config.dataDir !== undefined
}

/**
 * Resolve configuration from environment variables, then the config file beside
 * the program, then `config.json` in the data directory, then defaults.
 *
 * `programFile` is where to look for the file beside the program. It is not
 * looked for unless a place is given - the entrypoint gives one, and a test gets
 * a configuration that does not depend on what happens to be in the repository -
 * except that `MANGALIBRARY_CONFIG_FILE` always names one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, programFile: string | null = null): Config {
  const program = readProgramConfig(env, programFile)
  const configDir = resolve(setting(env, 'CONFIG_DIR') ?? program.config.dataDir ?? defaultDataDir(homedir()))
  // The file beside the program wins over the one in the data directory.
  const fileConfig: FileConfig = { ...readFileConfig(join(configDir, 'config.json')), ...program.config }

  const configuredPort = env.SERVER_PORT ?? env.PORT ?? fileConfig.port?.toString()
  const port = toNumber(configuredPort, DEFAULT_PORT, 'port')
  const host = env.SERVER_HOST ?? fileConfig.host ?? DEFAULT_HOST
  const logLevel = env.LOG_LEVEL ?? fileConfig.logLevel ?? DEFAULT_LOG_LEVEL
  const sessionTtlMs = toNumber(setting(env, 'SESSION_TTL_MS'), DEFAULT_SESSION_TTL_MS, 'session TTL')
  const databaseFile = resolve(
    setting(env, 'DATABASE_FILE') ?? fileConfig.databaseFile ?? join(configDir, 'database.sqlite'),
  )

  return {
    configDir,
    configFile: program.file,
    databaseFile,
    host,
    port,
    configuredPort: configuredPort === undefined || configuredPort === '' ? null : port,
    logLevel,
    sessionTtlMs,
    announcementsUrl: toUrl(setting(env, 'ANNOUNCEMENTS_URL') ?? fileConfig.announcementsUrl),
    releasesUrl: toUrl(setting(env, 'RELEASES_URL') ?? fileConfig.releasesUrl),
    corsAllowedOrigins: toList(setting(env, 'CORS_ALLOWED_ORIGINS') ?? fileConfig.corsAllowedOrigins),
    trustProxy: toSwitch(setting(env, 'TRUST_PROXY'), fileConfig.trustProxy ?? false),
    fontsDir: resolve(setting(env, 'FONTS_DIR') ?? fileConfig.fontsDir ?? join(configDir, 'fonts')),
    uiDir: toDirectory(setting(env, 'UI_DIR') ?? fileConfig.uiDir),
    workerThreads: toSwitch(setting(env, 'WORKER_THREADS'), fileConfig.workerThreads ?? true),
  }
}

/**
 * Make sure the database can be put where the configuration says, or say why not
 * in words somebody can act on. Creates the folder, as opening the database would.
 */
export function ensureWritable(config: Pick<Config, 'databaseFile'>): void {
  const folder = dirname(config.databaseFile)
  try {
    mkdirSync(folder, { recursive: true })
    accessSync(folder, constants.W_OK)
    if (existsSync(config.databaseFile)) accessSync(config.databaseFile, constants.R_OK | constants.W_OK)
  } catch (error) {
    throw new ConfigError(
      `The database cannot be kept at ${config.databaseFile}: ${(error as Error).message}. ` +
        'Check that the folder exists and that the user running the server may write to it.',
    )
  }
}
