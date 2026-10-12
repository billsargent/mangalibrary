/**
 * The compiled translations, one lazy import per locale file.
 *
 * `i18n:compile` writes `src/i18n/<locale>.json`, and this is what reads them back.
 * Vite's own glob does it rather than a plugin, because `vite-plugin-dir2json` worked
 * the paths out by string arithmetic on the path Vite gave it, and on Windows that
 * path has mixed separators: the imports it generated were written with backslashes -
 * which do not parse, so the production build could not be produced on Windows at all
 * - and the translations were keyed by the folder's absolute path, so no locale could
 * be found at runtime either. A glob is resolved by Vite itself, and its keys are the
 * same everywhere. See issue #91.
 *
 * The keys of the object below are the file names, and the values are the import
 * functions, so a locale is only read when it is asked for.
 */

export type LocaleLoader = () => Promise<{ default: Record<string, string> }>

/** The locale a compiled file names: `.../i18n/pt-BR.json` is `pt-BR`. */
function localeOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.json$/, '')
}

const compiled = import.meta.glob<{ default: Record<string, string> }>('../../i18n/*.json')

/** Every locale this build holds, and how to load it. */
export const localeFiles: Record<string, LocaleLoader> = Object.fromEntries(
  Object.entries(compiled).map(([path, load]) => [localeOf(path), load]),
)
