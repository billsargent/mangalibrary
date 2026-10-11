export interface ImportOptions {
  from: string
  to: string
  dryRun?: boolean
  rescanOnly?: boolean
  force?: boolean
}

/**
 * Migrate a legacy Komga config dir to the MangaLibrary schema.
 *
 * Placeholder: the real table-by-table mapping is implemented under its own
 * issue. This stub only reports the resolved paths so the CLI wiring can be
 * validated end to end.
 */
export function importKomga(options: ImportOptions): void {
  const { from, to } = options
  console.log(`[komga-import] from: ${from}`)
  console.log(`[komga-import] to:   ${to}`)
  console.log(`[komga-import] dry-run: ${options.dryRun === true}`)
  console.log('[komga-import] not implemented yet — see the importer issue.')
}
